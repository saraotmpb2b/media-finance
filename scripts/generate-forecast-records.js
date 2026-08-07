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
    const delTacticRaw = del.getCellValue(CONFIG.deliverableTacticField);
    const delTactic = delTacticRaw?.name || delTacticRaw;

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
const existingRecordsMap = new Map();
const unresolvedActiveForecastRecords = [];
// Pairs of {kept, dropped} where two live records resolved to the identical combo
// key - e.g. a deliverable's Vendor/Tactic changed to match a combo that already
// had its own row. Both rows still physically exist; only "kept" stays reachable
// through existingRecordsMap and keeps getting maintained. Both get flagged below.
const duplicateCombos = [];

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
        const recTactic = record.getCellValue("Tactic");

        if (!recCampaign || !recVendor) continue;

        resolvedCampaignId = recCampaign[0].id;
        resolvedVendorId = recVendor[0].id;
        resolvedTactic = recTactic;
    }

    const monthDate = new Date(recMonth);
    const key = `${resolvedCampaignId}|${resolvedVendorId}|${resolvedTactic}|${monthKey(monthDate)}`;

    const priorRecord = existingRecordsMap.get(key);

    if (!priorRecord) {
        existingRecordsMap.set(key, record);
    } else {
        // Collision: never let an Actual row become unreachable - real spend data
        // must never silently drop out of maintenance. If both are Actual, keep
        // whichever was already there; that's a genuine conflict needing human
        // review either way, not something safe to auto-resolve.
        const priorType = priorRecord.getCellValue("Record Type");
        const priorTypeText = priorType?.name || priorType;
        const recType = record.getCellValue("Record Type");
        const recTypeText = recType?.name || recType;

        let kept = priorRecord;
        let dropped = record;
        if (priorTypeText !== "Actual" && recTypeText === "Actual") {
            kept = record;
            dropped = priorRecord;
            existingRecordsMap.set(key, record);
        }

        duplicateCombos.push({kept, dropped});
    }

    // Only worth flagging when the campaign is still active - a non-live campaign
    // naturally has no current deliverable to resolve against, and that's expected.
    if (!resolvedViaLiveDeliverable && activeCampaignIds.has(resolvedCampaignId)) {
        unresolvedActiveForecastRecords.push(record);
    }
}

console.log(`Built lookup map with ${existingRecordsMap.size} existing records`);
console.log(`Duplicate combos detected: ${duplicateCombos.length}`);

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

// Helper: Get previous actuals for reweighting
function getPreviousActuals(campaignId, vendorId, tactic, beforeMonth) {
    let totalActuals = 0;

    for (const [key, record] of existingRecordsMap) {
        if (!key.startsWith(`${campaignId}|${vendorId}|${tactic}|`)) continue;

        const recMonth = record.getCellValue("Month");
        const recType = record.getCellValue("Record Type");
        const actualSpend = record.getCellValue("Actual Spend");

        const monthDate = new Date(recMonth);
        const recTypeText = recType?.name || recType;

        if (monthDate < beforeMonth && recTypeText === "Actual" && actualSpend) {
            totalActuals += actualSpend;
        }
    }

    return totalActuals;
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
        const tacticRaw = deliverable.getCellValue(CONFIG.deliverableTacticField);
        const budget = deliverable.getCellValue(CONFIG.deliverableBudgetField);

        const tactic = tacticRaw?.name || tacticRaw;

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

    // Calculate remaining budget after actuals
    const remainingBudget = totalTacticVendorBudget - previousActuals;

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
        const existingRecord = existingRecordsMap.get(lookupKey);

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

        // Apply reweighting if there are previous actuals
        let clientRevenue = baseClientRevenue;

        if (previousActuals > 0 && totalRemainingDays > 0) {
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
            const currentTotalBudget = existingRecord.getCellValue("Total Tactic/Vendor Budget") || 0;
            const currentPreviousActuals = existingRecord.getCellValue("Previous Months Actual") || 0;

            const revenueDiff = Math.abs(currentClientRevenue - clientRevenue);
            const costDiff = Math.abs(currentEstimatedCost - estimatedVendorCostRounded);
            const marginDiff = Math.abs(currentForecastedMargin - forecastedMarginRounded);
            const totalBudgetDiff = Math.abs(currentTotalBudget - totalTacticVendorBudgetRounded);
            const prevActualsDiff = Math.abs(currentPreviousActuals - monthPreviousActualsRounded);

            // Update if any values changed
            if (revenueDiff > 0.01 || costDiff > 0.01 || marginDiff > 0.01 ||
                currentBudgetCategoryText !== budgetCategory ||
                totalBudgetDiff > 0.01 || prevActualsDiff > 0.01) {
                recordsToUpdate.push({
                    id: existingRecord.id,
                    fields: {
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
// MAINTENANCE PASS: Update Total Tactic/Vendor Budget and Previous Months
// Actual on existing Actual records (and any past Forecast records that the
// main loop wouldn't touch). Only these two fields — never Record Type,
// Actual Spend, Client Revenue, or any Forecast-specific field.
// =========================================================================
const maintenanceUpdates = [];

for (const [comboKey, combo] of combinations) {
    const totalTacticVendorBudget = getTotalBudget(combo.deliverables);
    const totalTacticVendorBudgetRounded = Math.round(totalTacticVendorBudget * 100) / 100;
    const comboPrefix = `${combo.campaignId}|${combo.vendorId}|${combo.tactic}|`;

    for (const [existingKey, existingRecord] of existingRecordsMap) {
        if (!existingKey.startsWith(comboPrefix)) continue;

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

        const needsUpdate =
            totalBudgetIsBlank ||
            prevActualsIsBlank ||
            totalBudgetDiff > 0.01 ||
            prevActualsDiff > 0.01;

        if (!needsUpdate) continue;

        // Don't double-update a record the main loop already queued
        const alreadyQueued = recordsToUpdate.some(r => r.id === existingRecord.id);
        if (alreadyQueued) continue;

        maintenanceUpdates.push({
            id: existingRecord.id,
            fields: {
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
// DUPLICATE COMBO WARNING PASS: Flag both sides of a collision detected while
// building existingRecordsMap above - two real records that now resolve to
// the same Campaign/Vendor/Tactic/Month combo (typically a deliverable's
// Vendor/Tactic was edited to match a combo that already had its own row).
// Only one of the two stays reachable by the rest of this script; the other
// is a genuine duplicate that needs a human to merge or delete it.
// =========================================================================
const duplicateComboUpdates = [];

function queueDuplicateWarning(record, otherId, role) {
    const recType = record.getCellValue("Record Type");
    const recTypeText = recType?.name || recType;
    if (recTypeText !== "Forecast") return;

    const existingWarnings = record.getCellValue("Data Warnings") || "";
    if (existingWarnings.includes("DUPLICATE COMBO:")) return;

    const alreadyQueued = recordsToUpdate.some(r => r.id === record.id) ||
        maintenanceUpdates.some(r => r.id === record.id) ||
        orphanWarningUpdates.some(r => r.id === record.id) ||
        duplicateComboUpdates.some(r => r.id === record.id);
    if (alreadyQueued) return;

    const note = role === "kept"
        ? `DUPLICATE COMBO: record ${otherId} resolves to the same Campaign/Vendor/Tactic/Month combo as this one (likely a deliverable's Vendor/Tactic was changed to match an already-existing series). This record is being kept and maintained going forward; the other one is now stale. Please review and merge/delete the duplicate.`
        : `DUPLICATE COMBO: record ${otherId} now resolves to the same Campaign/Vendor/Tactic/Month combo as this one (likely a deliverable's Vendor/Tactic was changed to match an already-existing series). This record is no longer being updated by the forecast script - Total Tactic/Vendor Budget and Previous Months Actual here are frozen/stale. Please review and merge into the other record, then delete this one.`;

    duplicateComboUpdates.push({
        id: record.id,
        fields: {
            "Data Warnings": existingWarnings ? `${existingWarnings}\n${note}` : note
        }
    });
}

for (const {kept, dropped} of duplicateCombos) {
    queueDuplicateWarning(kept, dropped.id, "kept");
    queueDuplicateWarning(dropped, kept.id, "dropped");
}

console.log(`Duplicate combo warnings queued: ${duplicateComboUpdates.length}`);

// Execute
let created = 0;
let updated = 0;
let maintained = 0;
let flagged = 0;
let duplicatesFlagged = 0;

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

if (duplicateComboUpdates.length > 0) {
    while (duplicateComboUpdates.length > 0) {
        const batch = duplicateComboUpdates.splice(0, 50);
        await actualisationTable.updateRecordsAsync(batch);
        duplicatesFlagged += batch.length;
    }
}

console.log(`✅ Forecast Complete! Created: ${created}, Updated: ${updated}, Maintained: ${maintained}, Flagged: ${flagged}, Duplicates Flagged: ${duplicatesFlagged}`);

if (typeof output !== 'undefined' && typeof output.set === 'function') {
    output.set('recordsCreated', created);
    output.set('recordsUpdated', updated);
    output.set('recordsMaintained', maintained);
    output.set('recordsDuplicatesFlagged', duplicatesFlagged);
    output.set('recordsFlagged', flagged);
    output.set('status', 'success');
}
