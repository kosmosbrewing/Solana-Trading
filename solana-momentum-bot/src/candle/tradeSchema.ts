type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

export async function ensureTradeHighWaterMarkColumn(client: Queryable): Promise<void> {
  await client.query(`
    ALTER TABLE trades
    ADD COLUMN IF NOT EXISTS high_water_mark NUMERIC;
  `);

  // Open trades predating the column should start trailing from entry.
  await client.query(`
    UPDATE trades
    SET high_water_mark = entry_price
    WHERE status = 'OPEN' AND high_water_mark IS NULL;
  `);
}
