// Configuration
const CONFIG = {
    campaignStatusField: "Campaign Status",
    excludedCampaignStatuses: ["Cancelled"],
    campaignStartField: "Start Date",
    campaignEndField: "End Date",
    deliverableStartField: "Planned Start Date",
    deliverableEndField: "Planned End Date",
    deliverableBudgetField: "Planned Budget",
    deliverableTacticField: "Tactic",
    deliverableVendorField: "Platform/Vendor",
    deliverableCampaignField: "Campaign",
    deliverableMarginField: "Margin Rate",
    vendorBudgetCategoryField: "Budget Category"
};

// Get tables
const campaignsTable = base.getTable("Campaigns");
const deliverablesTable = base.getTable("Deliverables");
const actualisationTable = base.getTable("Monthly Actualisation");
const vendorsTable = base.getTable("Vendors");

const today = new Date();
const currentMonth = new Date(today.getFullYear(), today.getMonth(), 1);

// Helper: Convert a Date to "YYYY-MM" string using UTC components.
// Avoids timezone mismatches between Airtable-stored dates (UTC midnight)
// and locally-constructed dates (local midnight).
function monthKey(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Helper: Normalise a Tactic value to a trimmed string (or null).
// Some Tactic values carry trailing spaces ("High Impact  "), and the combo key is
// built from this text - so an untrimmed value silently forks a second parallel
// monthly series for what is really the same tactic. Trimming on both the key side
// and the write side keeps one series per tactic and stops the stale spaces from
// being copied into Actualisation rows.
function normaliseTactic(value) {
    const text = value?.name || value;
    if (typeof text !== "string") return text == null ? null : text;
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
}

console.log(`Generating Forecast records from ${currentMonth.toLocaleDateString('en-US', {month: 'long', year: 'numeric'})} onwards`);

// Load vendors and build Budget Category lookup
const vendorQuery = await vendorsTable.selectRecordsAsync({
    fields: [CONFIG.vendorBudgetCategoryField]
});

const vendorBudgetCategoryMap = new Map();
for (const vendor of vendorQuery.records) {
    const budgetCat = vendor.getCellValue(CONFIG.vendorBudgetCategoryField);
    const budgetCatText = budgetCat?.name || budgetCat || null;
    vendorBudgetCategoryMap.set(vendor.id, budgetCatText);
}

console.log(`Loaded ${vendorBudgetCategoryMap.size} vendors with Budget Categories`);

// Get all active campaigns with future end dates
const campaignQuery = await campaignsTable.selectRecordsAsync({
    fields: [
        CONFIG.campaignStatusField,
        CONFIG.campaignStartField,
        CONFIG.campaignEndField
    ]
});

const activeCampaigns = campaignQuery.records.filter(campaign => {
    const status = campaign.getCellValue(CONFIG.campaignStatusField);
    const endDate = campaign.getCellValue(CONFIG.campaignEndField);

    if (!endDate || !status) return false;

    const campaignEnd = new Date(endDate);
    const statusText = status?.name || status;
    const isNotExcluded = !CONFIG.excludedCampaignStatuses.includes(statusText);
    const isFutureOrCurrent = campaignEnd >= currentMonth;

    return isNotExcluded && isFutureOrCurrent;
});

console.log(`Found ${activeCampaigns.length} active campaigns`);

// Create a Set of active campaign IDs for fast lookup
const activeCampaignIds = new Set(activeCampaigns.map(c => c.id));

// Get only deliverables for active campaigns
const deliverableQuery = await deliverablesTable.selectRecordsAsync({
    fields: [
        CONFIG.deliverableCampaignField,
        CONFIG.deliverableVendorField,
        CONFIG.deliverableTacticField,
        CONFIG.deliverableStartField,
        CONFIG.deliverableEndField,
        CONFIG.deliverableBudgetField,
        CONFIG.deliverableMarginField,
        "Deliverable ID"
    ]
});

// Filter deliverables to only those linked to active campaigns
const relevantDeliverables = deliverableQuery.records.filter(del => {
    const delCampaign = del.getCellValue(CONFIG.deliverableCampaignField);
    return delCampaign && activeCampaignIds.has(delCampaign[0].id);
});

console.log(`Found ${relevantDeliverables.length} deliverables for active campaigns (filtered from ${deliverableQuery.records.length} total)`);

// Build a Campaign/Vendor/Tactic lookup for EVERY deliverable (not just active-campaign
// ones), keyed by deliverable record ID. This is the live, current-truth source used
// below to re-derive existing Actualisation records' combo key, since a deliverable's
// Vendor or Tactic can be edited/reassigned after Actualisation rows were created.
const deliverableInfoMap = new Map();
for (const del of deliverableQuery.records) {
    const delCampaign = del.getCellValue(CONFIG.deliverableCampaignField);
    const delVendor = del.getCellValue(CONFIG.deliverableVendorField);
    const delTactic = normaliseTactic(del.getCellValue(CONFIG.deliverableTacticField));

    if (!delCampaign || !delVendor || !delTactic) continue;

    deliverableInfoMap.set(del.id, {
        campaignId: delCampaign[0].id,
        vendorId: delVendor[0].id,
        tactic: delTactic
    });
}

// Get existing actualisation records
const actualisationQuery = await actualisationTable.selectRecordsAsync({
    fields: ["Campaign", "Vendor", "Tactic", "Month", "Record Type", "Client Revenue", "Estimated Vendor Cost", "Forecasted Margin $", "Margin %", "Deliverables", "Actual Spend", "Data Warnings", "Budget Category", "Total Tactic/Vendor Budget", "Previous Months Actual"]
});

// BUILD LOOKUP MAP - keyed by YYYY-MM string to avoid timezone issues
//
// The key is built from Campaign/Vendor/Tactic resolved through the record's LINKED
// Deliverables whenever possible, rather than the record's own Vendor/Tactic fields
// (which are a snapshot frozen at the time the row was created/last written). Without
// this, editing a deliverable's Tactic or Vendor after the fact (retagging, fixing a
// duplicate select option, reassigning) makes the old rows permanently unmatchable:
// the script forks a brand-new series instead of continuing the old one, and
// "Previous Months Actual" silently loses everything recorded under the old label.
// Falls back to the record's own fields when no linked deliverable resolves (e.g. it
// was deleted) so historical rows with no surviving deliverable still get keyed.
//
// Each key maps to a SLOT, not a bare record. Re-deriving the key from live
// deliverables means two rows created under different old labels can now land on
// the same combo+month; a plain map.set() would silently drop all but the last,
// leaving the others orphaned in the table while still counting toward rollups -
// and, worse, hiding their Actual Spend from getPreviousActuals. The slot keeps
// every colliding row: one primary (the row that carries recorded spend) plus
// duplicates, which get flagged for a human rather than deleted.
const existingRecordsMap = new Map();
const unresolvedActiveForecastRecords = [];

// Fields worth counting when deciding which of two colliding rows is more complete.
const COMPLETENESS_FIELDS = [
    "Client Revenue", "Estimated Vendor Cost", "Forecasted Margin $", "Actual Spend",
    "Total Tactic/Vendor Budget", "Previous Months Actual", "Budget Category", "Deliverables"
];

function filledFieldCount(record) {
    let filled = 0;
    for (const field of COMPLETENESS_FIELDS) {
        const value = record.getCellValue(field);
        if (value == null) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        if (typeof value === "number" && value === 0) continue;
        filled++;
    }
    return filled;
}

function isActualRecord(record) {
    const recType = record.getCellValue("Record Type");
    const recTypeText = recType?.name || recType;
    return recTypeText === "Actual";
}

// Actual Spend only counts when the row is actually marked Actual.
function actualSpendOf(record) {
    if (!isActualRecord(record)) return 0;
    return record.getCellValue("Actual Spend") || 0;
}

// Rank two rows competing for the same combo+month slot. A row carrying recorded
// Actual Spend always wins - dropping one is what silently corrupts Previous
// Months Actual. Then prefer the more completely filled row, then fall back to
// record id so the choice is deterministic across runs.
function isBetterPrimary(candidate, current) {
    const candidateSpend = Math.abs(actualSpendOf(candidate));
    const currentSpend = Math.abs(actualSpendOf(current));
    if ((candidateSpend > 0.01) !== (currentSpend > 0.01)) return candidateSpend > 0.01;

    const candidateFilled = filledFieldCount(candidate);
    const currentFilled = filledFieldCount(current);
    if (candidateFilled !== currentFilled) return candidateFilled > currentFilled;

    return candidate.id < current.id;
}

for (const record of actualisationQuery.records) {
    const recMonth = record.getCellValue("Month");
    if (!recMonth) continue;

    const recDeliverables = record.getCellValue("Deliverables");
    let resolvedCampaignId, resolvedVendorId, resolvedTactic;

    for (const linkedDel of recDeliverables || []) {
        const info = deliverableInfoMap.get(linkedDel.id);
        if (info) {
            resolvedCampaignId = info.campaignId;
            resolvedVendorId = info.vendorId;
            resolvedTactic = info.tactic;
            break;
        }
    }

    const resolvedViaLiveDeliverable = Boolean(resolvedCampaignId && resolvedVendorId);

    if (!resolvedViaLiveDeliverable) {
        const recCampaign = record.getCellValue("Campaign");
        const recVendor = record.getCellValue("Vendor");
        const recTactic = normaliseTactic(record.getCellValue("Tactic"));

        if (!recCampaign || !recVendor) continue;

        resolvedCampaignId = recCampaign[0].id;
        resolvedVendorId = recVendor[0].id;
        resolvedTactic = recTactic;
    }

    const monthDate = new Date(recMonth);
    const key = `${resolvedCampaignId}|${resolvedVendorId}|${resolvedTactic}|${monthKey(monthDate)}`;

    const slot = existingRecordsMap.get(key);
    if (!slot) {
        existingRecordsMap.set(key, {
            primary: record,
            duplicates: [],
            resolvedCampaignId: resolvedCampaignId,
            resolvedVendorId: resolvedVendorId,
            resolvedTactic: resolvedTactic
        });
    } else if (isBetterPrimary(record, slot.primary)) {
        slot.duplicates.push(slot.primary);
        slot.primary = record;
    } else {
        slot.duplicates.push(record);
    }

    // Only worth flagging when the campaign is still active - a non-live campaign
    // naturally has no current deliverable to resolve against, and that's expected.
    if (!resolvedViaLiveDeliverable && activeCampaignIds.has(resolvedCampaignId)) {
        unresolvedActiveForecastRecords.push(record);
    }
}

let duplicateRowCount = 0;
for (const slot of existingRecordsMap.values()) duplicateRowCount += slot.duplicates.length;

console.log(`Built lookup map with ${existingRecordsMap.size} combo+month slots covering ${existingRecordsMap.size + duplicateRowCount} existing records (${duplicateRowCount} duplicate rows)`);

// Index closed (Actual) months by combo, built from slot PRIMARIES only. Summing
// every row would double-count duplicates; summing a map that had silently dropped
// them lost their spend entirely. Primaries are chosen to be the spend-carrying row,
// so this both avoids double counting and stops losing recorded actuals.
//
// Each entry carries BOTH figures, because they answer different questions:
//   spend   - Actual Spend, i.e. net vendor cost. Only meaningful on a row marked
//             Actual. Feeds "Previous Months Actual", which finance reads as
//             literally "what we paid out".
//   revenue - Client Revenue on the row, i.e. gross, recorded regardless of Record
//             Type. Feeds the reweighting of remaining budget (getRecognisedRevenue).
//             Deliberately label-independent: the reweight only ever looks at months
//             that have already ended, and an ended month represents delivered time
//             whether or not anyone got round to relabelling it Actual. Keying off
//             the label instead would make the forecast depend on how promptly the
//             month was closed by hand.
const actualsByCombo = new Map();
for (const slot of existingRecordsMap.values()) {
    const spend = actualSpendOf(slot.primary);
    const revenue = slot.primary.getCellValue("Client Revenue") || 0;
    if (!spend && !revenue) continue;

    const recMonth = slot.primary.getCellValue("Month");
    if (!recMonth) continue;

    const comboKey = `${slot.resolvedCampaignId}|${slot.resolvedVendorId}|${slot.resolvedTactic}`;
    if (!actualsByCombo.has(comboKey)) actualsByCombo.set(comboKey, []);
    actualsByCombo.get(comboKey).push({time: new Date(recMonth).getTime(), spend: spend, revenue: revenue});
}

// Helper: Calculate days in month for a deliverable
function getDaysInMonth(delStart, delEnd, monthStart, monthEnd) {
    const rangeStart = delStart > monthStart ? delStart : monthStart;
    const rangeEnd = delEnd < monthEnd ? delEnd : monthEnd;

    if (rangeStart > monthEnd || rangeEnd < monthStart) return 0;

    const days = Math.ceil((rangeEnd - rangeStart) / (1000 * 60 * 60 * 24)) + 1;
    return days;
}

// Helper: Calculate deliverable budget for a month
function calculateDeliverableBudget(deliverable, monthStart, monthEnd) {
    const startDate = deliverable.getCellValue(CONFIG.deliverableStartField);
    const endDate = deliverable.getCellValue(CONFIG.deliverableEndField);
    const budget = deliverable.getCellValue(CONFIG.deliverableBudgetField);

    if (!startDate || !endDate || !budget) return 0;

    const delStart = new Date(startDate);
    const delEnd = new Date(endDate);

    const totalDays = Math.ceil((delEnd - delStart) / (1000 * 60 * 60 * 24)) + 1;
    const daysInMonth = getDaysInMonth(delStart, delEnd, monthStart, monthEnd);

    if (daysInMonth === 0 || totalDays === 0) return 0;

    return (budget / totalDays) * daysInMonth;
}

// Helper: Sum Actual Spend on closed months before a cutoff. This is the figure
// written to "Previous Months Actual" - net vendor cost, exactly as the name says.
// It is NOT the right basis for reweighting; see getRecognisedRevenue.
function getPreviousActuals(campaignId, vendorId, tactic, beforeMonth) {
    const entries = actualsByCombo.get(`${campaignId}|${vendorId}|${tactic}`);
    if (!entries) return 0;

    const cutoff = beforeMonth.getTime();
    let totalActuals = 0;
    for (const entry of entries) {
        if (entry.time < cutoff) totalActuals += entry.spend;
    }

    return totalActuals;
}

// Helper: Sum Client Revenue already recognised on closed months before a cutoff.
//
// This - not Actual Spend - is what must be subtracted from the total budget when
// reweighting the remaining forecast, for two reasons:
//
//  1. Units. The total budget is a sum of Planned Budget, which is GROSS client
//     revenue. Actual Spend is NET vendor cost. Subtracting net from gross and
//     assigning the result to Client Revenue silently leaks the margin.
//  2. Month close. A row flipped to Actual before finance enters Actual Spend
//     reports $0 spend, so the old basis concluded that nothing had been consumed
//     and re-spread the whole budget across the remaining months - while that
//     closed row still carried its revenue. The same money got counted twice, worst
//     in the month just closed. Client Revenue is present on the row from the moment
//     it is created, so it does not have that blind spot.
//
// Only ever called with a cutoff at the first forecast month, so every row it sums
// belongs to a month that has already ended.
function getRecognisedRevenue(campaignId, vendorId, tactic, beforeMonth) {
    const entries = actualsByCombo.get(`${campaignId}|${vendorId}|${tactic}`);
    if (!entries) return 0;

    const cutoff = beforeMonth.getTime();
    let totalRevenue = 0;
    for (const entry of entries) {
        if (entry.time < cutoff) totalRevenue += entry.revenue;
    }

    return totalRevenue;
}

// Helper: Get total budget
function getTotalBudget(deliverables) {
    return deliverables.reduce((sum, del) => {
        const budget = del.getCellValue(CONFIG.deliverableBudgetField);
        return sum + (budget || 0);
    }, 0);
}

// Helper: Get all months in campaign (from current month onwards)
function getMonthsInRange(campaignStartDate, campaignEndDate) {
    const months = [];
    const start = new Date(campaignStartDate);
    const end = new Date(campaignEndDate);

    let current = new Date(start.getFullYear(), start.getMonth(), 1);

    if (current < currentMonth) {
        current = new Date(currentMonth);
    }

    while (current <= end) {
        months.push(new Date(current));
        current.setMonth(current.getMonth() + 1);
    }

    return months;
}

// Helper: Calculate days per month for all deliverables across all remaining months
// Returns a Map of monthKey -> days
function calculateDaysPerMonth(deliverables, months) {
    const daysPerMonth = new Map();

    for (const month of months) {
        const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 0);
        let totalDaysThisMonth = 0;

        for (const deliverable of deliverables) {
            const startDate = deliverable.getCellValue(CONFIG.deliverableStartField);
            const endDate = deliverable.getCellValue(CONFIG.deliverableEndField);

            if (!startDate || !endDate) continue;

            const delStart = new Date(startDate);
            const delEnd = new Date(endDate);

            const days = getDaysInMonth(delStart, delEnd, month, monthEnd);
            totalDaysThisMonth += days;
        }

        daysPerMonth.set(monthKey(month), totalDaysThisMonth);
    }

    return daysPerMonth;
}

// Group deliverables by Campaign + Vendor + Tactic
const combinations = new Map();

for (const campaign of activeCampaigns) {
    const campaignId = campaign.id;
    const campaignStartDate = campaign.getCellValue(CONFIG.campaignStartField);
    const campaignEndDate = campaign.getCellValue(CONFIG.campaignEndField);

    const campaignDeliverables = relevantDeliverables.filter(del => {
        const delCampaign = del.getCellValue(CONFIG.deliverableCampaignField);
        return delCampaign && delCampaign[0].id === campaignId;
    });

    for (const deliverable of campaignDeliverables) {
        const vendor = deliverable.getCellValue(CONFIG.deliverableVendorField);
        const tactic = normaliseTactic(deliverable.getCellValue(CONFIG.deliverableTacticField));
        const budget = deliverable.getCellValue(CONFIG.deliverableBudgetField);

        if (!vendor || !tactic || !budget || budget === 0) continue;

        const vendorId = vendor[0].id;
        const key = `${campaignId}|${vendorId}|${tactic}`;

        if (!combinations.has(key)) {
            combinations.set(key, {
                campaignId: campaignId,
                vendorId: vendorId,
                tactic: tactic,
                campaignStartDate: campaignStartDate,
                campaignEndDate: campaignEndDate,
                deliverables: []
            });
        }

        combinations.get(key).deliverables.push(deliverable);
    }
}

console.log(`Found ${combinations.size} unique Campaign+Vendor+Tactic combinations`);

// Generate forecast records
const recordsToCreate = [];
const recordsToUpdate = [];

for (const [key, combo] of combinations) {
    const months = getMonthsInRange(combo.campaignStartDate, combo.campaignEndDate);

    if (months.length === 0) continue;

    // Get total budget for this combo (same for all months)
    const totalTacticVendorBudget = getTotalBudget(combo.deliverables);
    const totalTacticVendorBudgetRounded = Math.round(totalTacticVendorBudget * 100) / 100;

    // Get Budget Category from vendor lookup
    const budgetCategory = vendorBudgetCategoryMap.get(combo.vendorId);

    // Get previous actuals (based on first forecast month - same for all months in this run)
    const firstMonth = months[0];
    const previousActuals = getPreviousActuals(combo.campaignId, combo.vendorId, combo.tactic, firstMonth);
    const previousActualsRounded = Math.round(previousActuals * 100) / 100;

    // Revenue already recognised on closed months, on the same gross basis as the
    // budget. This is what has actually been consumed - see getRecognisedRevenue.
    const recognisedRevenue = getRecognisedRevenue(combo.campaignId, combo.vendorId, combo.tactic, firstMonth);

    // Calculate remaining budget, floored at zero. An overspent combo used to drive
    // this negative, which flowed straight through to Client Revenue, Estimated
    // Vendor Cost and Forecasted Margin - a forecast cannot bill back a past
    // overspend, so the remaining months are simply zero.
    const remainingBudget = Math.max(0, totalTacticVendorBudget - recognisedRevenue);

    // PRE-CALCULATE: Days per month for ALL remaining months (calculated ONCE)
    const daysPerMonth = calculateDaysPerMonth(combo.deliverables, months);

    // Calculate TOTAL remaining days across ALL months (not per-month!)
    let totalRemainingDays = 0;
    for (const days of daysPerMonth.values()) {
        totalRemainingDays += days;
    }

    for (const month of months) {
        const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 0);

        let warnings = [];

        const lookupKey = `${combo.campaignId}|${combo.vendorId}|${combo.tactic}|${monthKey(month)}`;
        const existingSlot = existingRecordsMap.get(lookupKey);
        const existingRecord = existingSlot ? existingSlot.primary : undefined;

        // Skip if record is already marked as Actual
        // (Actuals are handled by the maintenance pass at the end of the script)
        if (existingRecord) {
            const recType = existingRecord.getCellValue("Record Type");
            const recTypeText = recType?.name || recType;
            if (recTypeText === "Actual") {
                continue;
            }
        }

        // Calculate base client revenue for this month (day-weighted)
        let baseClientRevenue = 0;
        let marginSum = 0;
        let marginCount = 0;
        const deliverableIds = [];

        for (const deliverable of combo.deliverables) {
            const startDate = deliverable.getCellValue(CONFIG.deliverableStartField);
            const endDate = deliverable.getCellValue(CONFIG.deliverableEndField);
            const budget = deliverable.getCellValue(CONFIG.deliverableBudgetField);
            const deliverableName = deliverable.getCellValueAsString("Deliverable ID") || deliverable.id;

            if (!startDate || !endDate) {
                warnings.push(`Deliverable "${deliverableName}": Missing start/end dates`);
                continue;
            }

            if (!budget || budget === 0) {
                warnings.push(`Deliverable "${deliverableName}": $0 or missing budget`);
                continue;
            }

            const delBudget = calculateDeliverableBudget(deliverable, month, monthEnd);
            baseClientRevenue += delBudget;

            const margin = deliverable.getCellValue(CONFIG.deliverableMarginField);
            if (margin != null) {
                marginSum += margin;
                marginCount++;
            } else {
                warnings.push(`Deliverable "${deliverableName}": Missing margin rate`);
            }

            deliverableIds.push({id: deliverable.id});
        }

        // Apply reweighting once any revenue has been recognised on a closed month.
        // Gated on recognisedRevenue rather than previousActuals: a month closed
        // before its Actual Spend was entered has $0 spend but real recognised
        // revenue, and skipping the reweight there is what let the budget be spread
        // as though nothing had been delivered yet.
        let clientRevenue = baseClientRevenue;

        if (recognisedRevenue > 0 && totalRemainingDays > 0) {
            // Get this month's days from pre-calculated map
            const thisMonthDays = daysPerMonth.get(monthKey(month)) || 0;

            // Distribute remaining budget proportionally based on days
            // Using the SAME totalRemainingDays for all months (calculated once above)
            clientRevenue = (remainingBudget / totalRemainingDays) * thisMonthDays;
        }

        // Calculate average margin
        const avgMargin = marginCount > 0 ? marginSum / marginCount : 0;

        // Calculate estimated vendor cost and forecasted margin
        const estimatedVendorCost = clientRevenue * (1 - avgMargin);
        const forecastedMargin = clientRevenue - estimatedVendorCost;

        // Round values
        clientRevenue = Math.round(clientRevenue * 100) / 100;
        const estimatedVendorCostRounded = Math.round(estimatedVendorCost * 100) / 100;
        const forecastedMarginRounded = Math.round(forecastedMargin * 100) / 100;

        // Calculate Previous Months Actual for THIS specific month
        const monthPreviousActuals = getPreviousActuals(combo.campaignId, combo.vendorId, combo.tactic, month);
        const monthPreviousActualsRounded = Math.round(monthPreviousActuals * 100) / 100;

        if (existingRecord) {
            // Update existing Forecast record
            const currentClientRevenue = existingRecord.getCellValue("Client Revenue") || 0;
            const currentEstimatedCost = existingRecord.getCellValue("Estimated Vendor Cost") || 0;
            const currentForecastedMargin = existingRecord.getCellValue("Forecasted Margin $") || 0;
            const currentBudgetCategory = existingRecord.getCellValue("Budget Category");
            const currentBudgetCategoryText = currentBudgetCategory?.name || currentBudgetCategory;
            const currentVendorLink = existingRecord.getCellValue("Vendor");
            const currentVendorId = currentVendorLink && currentVendorLink.length ? currentVendorLink[0].id : null;
            // Compare the RAW stored text (not the normalised form) so a cell still
            // holding "High Impact  " gets rewritten clean once. combo.tactic is already
            // normalised, so after that single write the two match and this stops firing.
            const currentTacticStored = existingRecord.getCellValue("Tactic");
            const currentTacticText = currentTacticStored?.name || currentTacticStored;
            const currentTotalBudget = existingRecord.getCellValue("Total Tactic/Vendor Budget") || 0;
            const currentPreviousActuals = existingRecord.getCellValue("Previous Months Actual") || 0;

            const revenueDiff = Math.abs(currentClientRevenue - clientRevenue);
            const costDiff = Math.abs(currentEstimatedCost - estimatedVendorCostRounded);
            const marginDiff = Math.abs(currentForecastedMargin - forecastedMarginRounded);
            const totalBudgetDiff = Math.abs(currentTotalBudget - totalTacticVendorBudgetRounded);
            const prevActualsDiff = Math.abs(currentPreviousActuals - monthPreviousActualsRounded);

            // The row's own Vendor/Tactic cells are a snapshot from when it was written.
            // We already re-key off the live deliverable so the row keeps matching after a
            // deliverable is re-vendored or retagged - but unless we write the corrected
            // labels back, the row keeps *displaying* the old vendor/tactic forever, which
            // is what makes Actualisation disagree with Deliverables.
            const vendorIsStale = currentVendorId !== combo.vendorId;
            const tacticIsStale = (currentTacticText || null) !== (combo.tactic || null);

            // Update if any values changed
            if (revenueDiff > 0.01 || costDiff > 0.01 || marginDiff > 0.01 ||
                currentBudgetCategoryText !== budgetCategory ||
                totalBudgetDiff > 0.01 || prevActualsDiff > 0.01 ||
                vendorIsStale || tacticIsStale) {
                recordsToUpdate.push({
                    id: existingRecord.id,
                    fields: {
                        "Vendor": [{id: combo.vendorId}],
                        "Tactic": combo.tactic,
                        "Client Revenue": clientRevenue,
                        "Estimated Vendor Cost": estimatedVendorCostRounded,
                        "Forecasted Margin $": forecastedMarginRounded,
                        "Deliverables": deliverableIds,
                        "Data Warnings": warnings.length > 0 ? warnings.join("\n") : null,
                        "Budget Category": budgetCategory ? {name: budgetCategory} : null,
                        "Total Tactic/Vendor Budget": totalTacticVendorBudgetRounded,
                        "Previous Months Actual": monthPreviousActualsRounded
                    }
                });
            }
        } else {
            // Create new Forecast record
            recordsToCreate.push({
                fields: {
                    "Campaign": [{id: combo.campaignId}],
                    "Vendor": [{id: combo.vendorId}],
                    "Tactic": combo.tactic,
                    "Month": month,
                    "Record Type": {name: "Forecast"},
                    "Client Revenue": clientRevenue,
                    "Estimated Vendor Cost": estimatedVendorCostRounded,
                    "Forecasted Margin $": forecastedMarginRounded,
                    "Deliverables": deliverableIds,
                    "Data Warnings": warnings.length > 0 ? warnings.join("\n") : null,
                    "Budget Category": budgetCategory ? {name: budgetCategory} : null,
                    "Total Tactic/Vendor Budget": totalTacticVendorBudgetRounded,
                    "Previous Months Actual": monthPreviousActualsRounded
                }
            });
        }
    }
}

console.log(`Records to create: ${recordsToCreate.length}, Records to update: ${recordsToUpdate.length}`);

// =========================================================================
// MAINTENANCE PASS: Re-sync Vendor/Tactic labels and update Total Tactic/Vendor
// Budget and Previous Months Actual on existing Actual records (and any past
// Forecast records that the main loop wouldn't touch). Only these fields — never
// Record Type, Actual Spend, Client Revenue, or any Forecast-specific field.
//
// The Vendor/Tactic re-sync matters most here: the main loop skips Actual rows
// entirely, so without this an actualised month keeps showing the vendor it was
// booked under even after its deliverable moved to a different vendor.
// =========================================================================
const maintenanceUpdates = [];

for (const [comboKey, combo] of combinations) {
    const totalTacticVendorBudget = getTotalBudget(combo.deliverables);
    const totalTacticVendorBudgetRounded = Math.round(totalTacticVendorBudget * 100) / 100;
    const comboPrefix = `${combo.campaignId}|${combo.vendorId}|${combo.tactic}|`;

    for (const [existingKey, slot] of existingRecordsMap) {
        if (!existingKey.startsWith(comboPrefix)) continue;

        const existingRecord = slot.primary;

        const recMonth = existingRecord.getCellValue("Month");
        if (!recMonth) continue;
        const monthDate = new Date(recMonth);

        const monthPreviousActuals = getPreviousActuals(combo.campaignId, combo.vendorId, combo.tactic, monthDate);
        const monthPreviousActualsRounded = Math.round(monthPreviousActuals * 100) / 100;

        const currentTotalBudgetRaw = existingRecord.getCellValue("Total Tactic/Vendor Budget");
        const currentPreviousActualsRaw = existingRecord.getCellValue("Previous Months Actual");

        const totalBudgetIsBlank = currentTotalBudgetRaw == null;
        const prevActualsIsBlank = currentPreviousActualsRaw == null;

        const totalBudgetDiff = Math.abs((currentTotalBudgetRaw || 0) - totalTacticVendorBudgetRounded);
        const prevActualsDiff = Math.abs((currentPreviousActualsRaw || 0) - monthPreviousActualsRounded);

        const currentVendorLink = existingRecord.getCellValue("Vendor");
        const currentVendorId = currentVendorLink && currentVendorLink.length ? currentVendorLink[0].id : null;
        const currentTacticStored = existingRecord.getCellValue("Tactic");
        const currentTacticText = currentTacticStored?.name || currentTacticStored;

        const vendorIsStale = currentVendorId !== combo.vendorId;
        const tacticIsStale = (currentTacticText || null) !== (combo.tactic || null);

        const needsUpdate =
            totalBudgetIsBlank ||
            prevActualsIsBlank ||
            totalBudgetDiff > 0.01 ||
            prevActualsDiff > 0.01 ||
            vendorIsStale ||
            tacticIsStale;

        if (!needsUpdate) continue;

        // Don't double-update a record the main loop already queued
        const alreadyQueued = recordsToUpdate.some(r => r.id === existingRecord.id);
        if (alreadyQueued) continue;

        maintenanceUpdates.push({
            id: existingRecord.id,
            fields: {
                "Vendor": [{id: combo.vendorId}],
                "Tactic": combo.tactic,
                "Total Tactic/Vendor Budget": totalTacticVendorBudgetRounded,
                "Previous Months Actual": monthPreviousActualsRounded
            }
        });
    }
}

console.log(`Maintenance updates queued: ${maintenanceUpdates.length}`);

// =========================================================================
// ORPHAN WARNING PASS: Flag Forecast records for still-active campaigns whose
// combo could not be resolved to any currently-live deliverable (its linked
// deliverable was likely deleted). These rows are otherwise untouched by the
// main loop or maintenance pass, so without this they'd silently sit with
// stale Total Tactic/Vendor Budget / Previous Months Actual values.
// =========================================================================
const ORPHAN_WARNING = "No live deliverable could be matched to this record (it may have been deleted or reassigned) - Total Tactic/Vendor Budget and Previous Months Actual may be stale. Please review.";
const orphanWarningUpdates = [];

for (const record of unresolvedActiveForecastRecords) {
    const recType = record.getCellValue("Record Type");
    const recTypeText = recType?.name || recType;
    if (recTypeText !== "Forecast") continue;

    const existingWarnings = record.getCellValue("Data Warnings") || "";
    if (existingWarnings.includes(ORPHAN_WARNING)) continue;

    const alreadyQueued = recordsToUpdate.some(r => r.id === record.id) || maintenanceUpdates.some(r => r.id === record.id);
    if (alreadyQueued) continue;

    orphanWarningUpdates.push({
        id: record.id,
        fields: {
            "Data Warnings": existingWarnings ? `${existingWarnings}\n${ORPHAN_WARNING}` : ORPHAN_WARNING
        }
    });
}

console.log(`Orphan warnings queued: ${orphanWarningUpdates.length}`);

// =========================================================================
// DUPLICATE WARNING PASS: Flag the non-primary rows in any combo+month slot that
// ended up with more than one row. These are almost always left over from runs
// made before the combo key was re-derived from live deliverables: the old row
// was booked under a since-changed vendor/tactic, the run forked a new series,
// and both now resolve to the same slot.
//
// Deliberately does NOT delete them - a row may carry Actual Spend a human still
// needs to reconcile, and this script must never destroy recorded spend. It only
// marks them so they can be merged by hand.
// =========================================================================
const DUPLICATE_WARNING = "Duplicate row for this Campaign/Vendor/Tactic/Month - another row is being treated as the source of truth and this one is excluded from Previous Months Actual. Merge any spend recorded here into the primary row, then delete this row.";
const duplicateWarningUpdates = [];

for (const slot of existingRecordsMap.values()) {
    if (slot.duplicates.length === 0) continue;
    if (!activeCampaignIds.has(slot.resolvedCampaignId)) continue;

    for (const duplicate of slot.duplicates) {
        const existingWarnings = duplicate.getCellValue("Data Warnings") || "";
        if (existingWarnings.includes(DUPLICATE_WARNING)) continue;

        const alreadyQueued =
            recordsToUpdate.some(r => r.id === duplicate.id) ||
            maintenanceUpdates.some(r => r.id === duplicate.id) ||
            orphanWarningUpdates.some(r => r.id === duplicate.id);
        if (alreadyQueued) continue;

        duplicateWarningUpdates.push({
            id: duplicate.id,
            fields: {
                "Data Warnings": existingWarnings ? `${existingWarnings}\n${DUPLICATE_WARNING}` : DUPLICATE_WARNING
            }
        });
    }
}

console.log(`Duplicate warnings queued: ${duplicateWarningUpdates.length}`);

// =========================================================================
// MONTH CLOSE PASS: Flip Forecast rows whose month has fully ended over to Actual.
//
// The script previously had no month-close transition at all, so this was done by
// hand every month. Two things made that costly: the main loop only looks at the
// current month onwards, so a past row left as Forecast was never revisited again;
// and a large manual edit is exactly where rows get missed or half-updated.
//
// Only Record Type is written. Actual Spend is deliberately left alone - what was
// actually paid is finance's to enter, and guessing it here would be inventing
// numbers. Until it is entered the row keeps its forecast Client Revenue, which is
// the right estimate to carry and is already what the reweighting consumes.
// =========================================================================
const monthCloseUpdates = [];

for (const [existingKey, slot] of existingRecordsMap) {
    const record = slot.primary;

    if (isActualRecord(record)) continue;
    if (!activeCampaignIds.has(slot.resolvedCampaignId)) continue;

    const recMonth = record.getCellValue("Month");
    if (!recMonth) continue;

    // Strictly before the current month, so a month still in progress is never
    // closed early.
    const monthDate = new Date(recMonth);
    const rowMonthStart = new Date(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1);
    if (rowMonthStart >= currentMonth) continue;

    monthCloseUpdates.push({
        id: record.id,
        fields: {
            "Record Type": {name: "Actual"}
        }
    });
}

console.log(`Month close (Forecast -> Actual) queued: ${monthCloseUpdates.length}`);

// Execute
let created = 0;
let updated = 0;
let maintained = 0;
let flagged = 0;
let duplicatesFlagged = 0;
let closed = 0;

if (recordsToCreate.length > 0) {
    while (recordsToCreate.length > 0) {
        const batch = recordsToCreate.splice(0, 50);
        await actualisationTable.createRecordsAsync(batch);
        created += batch.length;
    }
}

if (recordsToUpdate.length > 0) {
    while (recordsToUpdate.length > 0) {
        const batch = recordsToUpdate.splice(0, 50);
        await actualisationTable.updateRecordsAsync(batch);
        updated += batch.length;
    }
}

if (maintenanceUpdates.length > 0) {
    while (maintenanceUpdates.length > 0) {
        const batch = maintenanceUpdates.splice(0, 50);
        await actualisationTable.updateRecordsAsync(batch);
        maintained += batch.length;
    }
}

if (orphanWarningUpdates.length > 0) {
    while (orphanWarningUpdates.length > 0) {
        const batch = orphanWarningUpdates.splice(0, 50);
        await actualisationTable.updateRecordsAsync(batch);
        flagged += batch.length;
    }
}

if (duplicateWarningUpdates.length > 0) {
    while (duplicateWarningUpdates.length > 0) {
        const batch = duplicateWarningUpdates.splice(0, 50);
        await actualisationTable.updateRecordsAsync(batch);
        duplicatesFlagged += batch.length;
    }
}

if (monthCloseUpdates.length > 0) {
    while (monthCloseUpdates.length > 0) {
        const batch = monthCloseUpdates.splice(0, 50);
        await actualisationTable.updateRecordsAsync(batch);
        closed += batch.length;
    }
}

console.log(`✅ Forecast Complete! Created: ${created}, Updated: ${updated}, Maintained: ${maintained}, Flagged: ${flagged}, Duplicates flagged: ${duplicatesFlagged}, Months closed: ${closed}`);

if (typeof output !== 'undefined' && typeof output.set === 'function') {
    output.set('recordsCreated', created);
    output.set('recordsUpdated', updated);
    output.set('recordsMaintained', maintained);
    output.set('recordsFlagged', flagged);
    output.set('duplicatesFlagged', duplicatesFlagged);
    output.set('monthsClosed', closed);
    output.set('status', 'success');
}
