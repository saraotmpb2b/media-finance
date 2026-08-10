// =========================================================================
// Calculates "Actual Tactic Cost" (TMP's real cost) on Monthly Actualisation
// records for whichever month is currently being actualised - e.g. running
// this on Weekday 1 of August fills in July, per the team's actualisation
// cadence.
//
// "Actual Revenue (Platform Costs)" is a FORMULA field ({Actual Spend} -
// {Actual Tactic Cost}) - it can't be written to directly, and it can't be
// used as an "is this done yet" check either: in Airtable, a blank number
// field acts as 0 in arithmetic, so that formula already shows a plain
// number (= Actual Spend) the moment Actual Spend is filled in, even before
// Actual Tactic Cost has been set. The real "not yet calculated" signal is
// Actual Tactic Cost itself being blank - that's what this script checks
// and populates. Once it's set, Actual Revenue (Platform Costs) resolves
// on its own.
//
// The margin rate below mirrors the convention used in generate-forecast-
// records.js (cost = revenue * (1 - margin)): a rate of 0 means cost equals
// Actual Spend (pure pass-through, no margin - e.g. Search); a rate of 1
// means cost is $0 (entirely fee income, no vendor cost - Media Management
// Fees).
// =========================================================================

const CONFIG = {
    monthField: "Month",
    budgetCategoryField: "Budget Category",
    officeField: "tmp Office",
    clientField: "Client",
    actualSpendField: "Actual Spend",
    actualTacticCostField: "Actual Tactic Cost",
    recordTypeField: "Record Type",
    dataWarningsField: "Data Warnings"
};

const actualisationTable = base.getTable("Monthly Actualisation");

// The month currently being actualised is always the calendar month before
// this script runs.
const today = new Date();
const targetMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));

// Convert a Date to "YYYY-MM" using UTC components, to avoid timezone
// mismatches between Airtable-stored dates (UTC midnight) and locally
// constructed dates (local midnight) - same convention as the forecast script.
function monthKey(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

const targetMonthKey = monthKey(targetMonth);
console.log(`Calculating Actual Tactic Cost for ${targetMonth.toLocaleDateString('en-US', {month: 'long', year: 'numeric'})}`);

// Margin rate by Budget Category. Any category not listed here (including
// combo options like "External 3rd Party, Social") falls through to the
// same 0% default as the source formula.
function marginRateFor(budgetCategory, officeName, clientName) {
    switch (budgetCategory) {
        case "Social":
            return 0;
        case "Search":
            return 0;
        case "External 3rd Party":
            return officeName === "EMEA" ? 0.15 : 0;
        case "Media Management Fees":
            return 1;
        case "Internal Content Syndication":
            return 0.60;
        case "Internal Programmatic":
            return (clientName === "Anaplan" || clientName === "Fortinet") ? 0.30 : 0.50;
        default:
            return 0;
    }
}

const query = await actualisationTable.selectRecordsAsync({
    fields: [
        CONFIG.monthField,
        CONFIG.budgetCategoryField,
        CONFIG.officeField,
        CONFIG.clientField,
        CONFIG.actualSpendField,
        CONFIG.actualTacticCostField,
        CONFIG.recordTypeField,
        CONFIG.dataWarningsField
    ]
});

const updates = [];
let skippedAlreadySet = 0;
let skippedNoSpend = 0;
let skippedNoMonth = 0;

for (const record of query.records) {
    const recMonth = record.getCellValue(CONFIG.monthField);
    if (!recMonth) {
        skippedNoMonth++;
        continue;
    }
    if (monthKey(new Date(recMonth)) !== targetMonthKey) continue;

    const existingCost = record.getCellValue(CONFIG.actualTacticCostField);
    if (existingCost != null) {
        skippedAlreadySet++;
        continue;
    }

    const actualSpend = record.getCellValue(CONFIG.actualSpendField);
    if (actualSpend == null) {
        skippedNoSpend++;
        continue;
    }

    const budgetCategoryRaw = record.getCellValue(CONFIG.budgetCategoryField);
    const budgetCategory = budgetCategoryRaw?.name || budgetCategoryRaw;

    const officeRaw = record.getCellValue(CONFIG.officeField);
    const officeValue = Array.isArray(officeRaw) ? officeRaw[0] : officeRaw;
    const officeName = officeValue?.name || officeValue;

    const clientRaw = record.getCellValue(CONFIG.clientField);
    const clientValue = Array.isArray(clientRaw) ? clientRaw[0] : clientRaw;
    const clientName = clientValue?.name || clientValue;

    const marginRate = marginRateFor(budgetCategory, officeName, clientName);
    const actualTacticCost = Math.round(actualSpend * (1 - marginRate) * 100) / 100;

    const fields = {[CONFIG.actualTacticCostField]: actualTacticCost};
    const existingWarnings = record.getCellValue(CONFIG.dataWarningsField) || "";
    const newWarnings = [];

    if (!budgetCategory) {
        newWarnings.push("Missing Budget Category - Actual Tactic Cost was calculated using the 0% default margin rate (cost = Actual Spend). Please set the correct Budget Category and re-check this record's cost.");
    } else if (budgetCategory === "External 3rd Party" && !officeName) {
        newWarnings.push("External 3rd Party record with no resolvable tmp Office - Actual Tactic Cost was calculated assuming non-EMEA (0% margin). Please verify.");
    } else if (budgetCategory === "Internal Programmatic" && !clientName) {
        newWarnings.push("Internal Programmatic record with no resolvable Client - Actual Tactic Cost was calculated using the standard 50% margin rate. Please verify the Client and re-check if it should be 30% (Anaplan/Fortinet).");
    }

    if (newWarnings.length > 0) {
        const toAdd = newWarnings.filter(note => !existingWarnings.includes(note));
        if (toAdd.length > 0) {
            fields[CONFIG.dataWarningsField] = existingWarnings ? `${existingWarnings}\n${toAdd.join("\n")}` : toAdd.join("\n");
        }
    }

    updates.push({id: record.id, fields});
}

console.log(`Records to update: ${updates.length}, skipped (already set): ${skippedAlreadySet}, skipped (no Actual Spend yet): ${skippedNoSpend}, skipped (no Month): ${skippedNoMonth}`);

let updated = 0;
if (updates.length > 0) {
    while (updates.length > 0) {
        const batch = updates.splice(0, 50);
        await actualisationTable.updateRecordsAsync(batch);
        updated += batch.length;
    }
}

console.log(`✅ Actual Tactic Cost calculation complete! Updated: ${updated}`);

if (typeof output !== 'undefined' && typeof output.set === 'function') {
    output.set('recordsUpdated', updated);
    output.set('recordsSkippedAlreadySet', skippedAlreadySet);
    output.set('recordsSkippedNoSpend', skippedNoSpend);
    output.set('status', 'success');
}
