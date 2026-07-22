// Configuration
const CONFIG = {
    campaignField: "Campaign",
    monthField: "Month",
    recordTypeField: "Record Type",
    clientRevenueField: "Client Revenue",
    actualSpendField: "Actual Spend"
};

// Get tables
const actualisationTable = base.getTable("Monthly Actualisation");
const performanceTable = base.getTable("Campaign Monthly Performance");

// Pull every Actual row - this report is a post-actualisation review, so Forecast-only
// months (nothing actualized yet) are intentionally left out.
const actualisationQuery = await actualisationTable.selectRecordsAsync({
    fields: [CONFIG.campaignField, CONFIG.monthField, CONFIG.recordTypeField, CONFIG.clientRevenueField, CONFIG.actualSpendField]
});

const actualRecords = actualisationQuery.records.filter(record => {
    const recType = record.getCellValue(CONFIG.recordTypeField);
    const recTypeText = recType?.name || recType;
    return recTypeText === "Actual";
});

console.log(`Found ${actualRecords.length} Actual records (out of ${actualisationQuery.records.length} total)`);

// Roll up Client Revenue and Actual Spend by Campaign + Month, across every
// vendor/tactic - this report is a campaign-level summary, not a deliverable breakdown.
function monthKey(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

const rollups = new Map();

for (const record of actualRecords) {
    const campaign = record.getCellValue(CONFIG.campaignField);
    const month = record.getCellValue(CONFIG.monthField);
    if (!campaign || !month) continue;

    const campaignId = campaign[0].id;
    const campaignName = campaign[0].name;
    const monthDate = new Date(month);
    const key = `${campaignId}|${monthKey(monthDate)}`;

    if (!rollups.has(key)) {
        rollups.set(key, {
            campaignId,
            campaignName,
            month: new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1)),
            clientRevenue: 0,
            actualSpend: 0
        });
    }

    const rollup = rollups.get(key);
    rollup.clientRevenue += record.getCellValue(CONFIG.clientRevenueField) || 0;
    rollup.actualSpend += record.getCellValue(CONFIG.actualSpendField) || 0;
}

console.log(`Rolled up into ${rollups.size} Campaign+Month combinations`);

// Get existing Campaign Monthly Performance records to decide create vs. update
const performanceQuery = await performanceTable.selectRecordsAsync({
    fields: ["Campaign", "Month", "Client Revenue", "Actual Spend"]
});

const existingMap = new Map();
for (const record of performanceQuery.records) {
    const campaign = record.getCellValue("Campaign");
    const month = record.getCellValue("Month");
    if (!campaign || !month) continue;

    const monthDate = new Date(month);
    const key = `${campaign[0].id}|${monthKey(monthDate)}`;
    existingMap.set(key, record);
}

const recordsToCreate = [];
const recordsToUpdate = [];

for (const [key, rollup] of rollups) {
    const clientRevenueRounded = Math.round(rollup.clientRevenue * 100) / 100;
    const actualSpendRounded = Math.round(rollup.actualSpend * 100) / 100;
    const monthLabel = rollup.month.toLocaleDateString('en-US', {month: 'short', year: 'numeric', timeZone: 'UTC'});
    const name = `${rollup.campaignName} — ${monthLabel}`;

    const existingRecord = existingMap.get(key);

    if (existingRecord) {
        const currentClientRevenue = existingRecord.getCellValue("Client Revenue") || 0;
        const currentActualSpend = existingRecord.getCellValue("Actual Spend") || 0;

        const revenueDiff = Math.abs(currentClientRevenue - clientRevenueRounded);
        const spendDiff = Math.abs(currentActualSpend - actualSpendRounded);

        if (revenueDiff > 0.01 || spendDiff > 0.01) {
            recordsToUpdate.push({
                id: existingRecord.id,
                fields: {
                    "Name": name,
                    "Client Revenue": clientRevenueRounded,
                    "Actual Spend": actualSpendRounded
                }
            });
        }
    } else {
        recordsToCreate.push({
            fields: {
                "Name": name,
                "Campaign": [{id: rollup.campaignId}],
                "Month": rollup.month,
                "Client Revenue": clientRevenueRounded,
                "Actual Spend": actualSpendRounded
            }
        });
    }
}

console.log(`Records to create: ${recordsToCreate.length}, Records to update: ${recordsToUpdate.length}`);

// Execute
let created = 0;
let updated = 0;

if (recordsToCreate.length > 0) {
    while (recordsToCreate.length > 0) {
        const batch = recordsToCreate.splice(0, 50);
        await performanceTable.createRecordsAsync(batch);
        created += batch.length;
    }
}

if (recordsToUpdate.length > 0) {
    while (recordsToUpdate.length > 0) {
        const batch = recordsToUpdate.splice(0, 50);
        await performanceTable.updateRecordsAsync(batch);
        updated += batch.length;
    }
}

console.log(`✅ Campaign Monthly Performance refreshed! Created: ${created}, Updated: ${updated}`);

if (typeof output !== 'undefined' && typeof output.set === 'function') {
    output.set('recordsCreated', created);
    output.set('recordsUpdated', updated);
    output.set('status', 'success');
}
