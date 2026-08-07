// ============================================================
// Monthly Actualisation: Forecast -> Actual Cutover (runs 28th of month)
// ============================================================
// TASK 1: Converts THIS calendar month's Forecast records to Actual.
// TASK 2: Reconciles Total Tactic/Vendor Budget + Previous Months Actual on
//         every existing Actual record - not just ones missing a value,
//         since a value set before a deliverable changed is just as stale
//         as a blank one.
//
// Both tasks resolve each record's Campaign/Vendor/Tactic combo through its
// linked Deliverables (live truth), the same way the main forecast script
// does, instead of trusting the record's own frozen Tactic text. Without
// this, a deliverable's Vendor/Tactic being edited after the fact forks a
// duplicate series here too, and Previous Months Actual silently loses
// everything recorded under the old label.
// ============================================================

const CONFIG = {
    deliverableCampaignField: "Campaign",
    deliverableVendorField: "Platform/Vendor",
    deliverableTacticField: "Tactic",
    deliverableBudgetField: "Planned Budget"
};

const actualisationTable = base.getTable("Monthly Actualisation");
const deliverablesTable = base.getTable("Deliverables");

// Convert THIS calendar month's Forecasts - computed relative to today, so
// this keeps working every month without anyone having to edit the script.
const today = new Date();
const CONVERT_MONTH = new Date(today.getFullYear(), today.getMonth(), 1);

console.log("Converting Forecasts for: " + CONVERT_MONTH.toLocaleDateString('en-US', {month: 'long', year: 'numeric'}));

// Load deliverables and build the live Campaign/Vendor/Tactic + Budget lookup,
// keyed by deliverable ID.
const delQuery = await deliverablesTable.selectRecordsAsync({
    fields: [CONFIG.deliverableCampaignField, CONFIG.deliverableVendorField, CONFIG.deliverableTacticField, CONFIG.deliverableBudgetField]
});

const deliverableInfoMap = new Map();
for (const del of delQuery.records) {
    const delCampaign = del.getCellValue(CONFIG.deliverableCampaignField);
    const delVendor = del.getCellValue(CONFIG.deliverableVendorField);
    const delTacticRaw = del.getCellValue(CONFIG.deliverableTacticField);
    const delTactic = delTacticRaw?.name || delTacticRaw;
    const delBudget = del.getCellValue(CONFIG.deliverableBudgetField) || 0;

    if (!delCampaign || !delVendor || !delTactic) continue;

    deliverableInfoMap.set(del.id, {
        campaignId: delCampaign[0].id,
        vendorId: delVendor[0].id,
        tactic: delTactic,
        budget: delBudget
    });
}

// Sum of every deliverable's budget per resolved combo - the same
// full-combo total the main forecast script uses, not just what's linked
// to one specific record.
const budgetByCombo = new Map();
for (const info of deliverableInfoMap.values()) {
    const comboKey = info.campaignId + "|" + info.vendorId + "|" + info.tactic;
    budgetByCombo.set(comboKey, (budgetByCombo.get(comboKey) || 0) + info.budget);
}

function resolveCombo(record) {
    const recDeliverables = record.getCellValue("Deliverables");
    for (const linkedDel of recDeliverables || []) {
        const info = deliverableInfoMap.get(linkedDel.id);
        if (info) {
            return {campaignId: info.campaignId, vendorId: info.vendorId, tactic: info.tactic};
        }
    }

    const recCampaign = record.getCellValue("Campaign");
    const recVendor = record.getCellValue("Vendor");
    const recTactic = record.getCellValue("Tactic");
    if (!recCampaign || !recVendor) return null;

    return {campaignId: recCampaign[0].id, vendorId: recVendor[0].id, tactic: recTactic};
}

// Load every Monthly Actualisation record
const actQuery = await actualisationTable.selectRecordsAsync({
    fields: ["Campaign", "Vendor", "Tactic", "Month", "Record Type",
             "Total Tactic/Vendor Budget", "Previous Months Actual",
             "Actual Spend", "Deliverables"]
});

// Index Actual spend by resolved combo, for Previous Months Actual
const spendByCombo = new Map();
const forecastsToConvert = [];
const actualRecords = [];

for (const record of actQuery.records) {
    const combo = resolveCombo(record);
    const month = record.getCellValue("Month");
    if (!combo || !month) continue;

    const recType = record.getCellValue("Record Type");
    const recTypeText = recType?.name || recType;
    const monthDate = new Date(month);
    const comboKey = combo.campaignId + "|" + combo.vendorId + "|" + combo.tactic;

    if (recTypeText === "Actual") {
        const actualSpend = record.getCellValue("Actual Spend");
        if (actualSpend) {
            if (!spendByCombo.has(comboKey)) spendByCombo.set(comboKey, []);
            spendByCombo.get(comboKey).push({month: monthDate, spend: actualSpend});
        }
        actualRecords.push({record, comboKey, monthDate});
    }

    if (recTypeText === "Forecast" &&
        monthDate.getFullYear() === CONVERT_MONTH.getFullYear() &&
        monthDate.getMonth() === CONVERT_MONTH.getMonth()) {
        forecastsToConvert.push({record, comboKey, monthDate});
    }
}

function previousActualFor(comboKey, beforeMonth) {
    const entries = spendByCombo.get(comboKey) || [];
    let total = 0;
    for (const entry of entries) {
        if (entry.month < beforeMonth) total += entry.spend;
    }
    return Math.round(total * 100) / 100;
}

console.log("Forecasts to convert to Actual: " + forecastsToConvert.length);

// TASK 1: Convert this month's Forecasts to Actual
const convertUpdates = forecastsToConvert.map(function (item) {
    const totalBudget = Math.round((budgetByCombo.get(item.comboKey) || 0) * 100) / 100;
    return {
        id: item.record.id,
        fields: {
            "Record Type": {name: "Actual"},
            "Total Tactic/Vendor Budget": totalBudget,
            "Previous Months Actual": previousActualFor(item.comboKey, item.monthDate)
        }
    };
});

// TASK 2: Reconcile Total Tactic/Vendor Budget + Previous Months Actual on
// every existing Actual record.
const budgetUpdates = [];
for (const item of actualRecords) {
    const newTotalBudget = Math.round((budgetByCombo.get(item.comboKey) || 0) * 100) / 100;
    const newPreviousActual = previousActualFor(item.comboKey, item.monthDate);

    const currentTotalBudget = item.record.getCellValue("Total Tactic/Vendor Budget");
    const currentPreviousActual = item.record.getCellValue("Previous Months Actual");

    const totalBudgetDiff = Math.abs((currentTotalBudget || 0) - newTotalBudget);
    const previousActualDiff = Math.abs((currentPreviousActual || 0) - newPreviousActual);

    if (currentTotalBudget == null || currentPreviousActual == null || totalBudgetDiff > 0.01 || previousActualDiff > 0.01) {
        budgetUpdates.push({
            id: item.record.id,
            fields: {
                "Total Tactic/Vendor Budget": newTotalBudget,
                "Previous Months Actual": newPreviousActual
            }
        });
    }
}

console.log("Actuals needing budget reconciliation: " + budgetUpdates.length);

// EXECUTE - convert first, then reconcile, skipping anything Task 1 already
// touched this run.
let converted = 0;
let reconciled = 0;

const convertIds = new Set(convertUpdates.map(function (r) { return r.id; }));
const dedupedBudgetUpdates = budgetUpdates.filter(function (r) { return !convertIds.has(r.id); });

while (convertUpdates.length > 0) {
    const batch = convertUpdates.splice(0, 50);
    await actualisationTable.updateRecordsAsync(batch);
    converted += batch.length;
}

while (dedupedBudgetUpdates.length > 0) {
    const batch = dedupedBudgetUpdates.splice(0, 50);
    await actualisationTable.updateRecordsAsync(batch);
    reconciled += batch.length;
}

console.log("Converted: " + converted + ", Reconciled: " + reconciled);

if (typeof output !== 'undefined' && typeof output.set === 'function') {
    output.set('recordsConverted', converted);
    output.set('recordsReconciled', reconciled);
    output.set('status', 'success');
}
