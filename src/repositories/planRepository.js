async function findById(client, planId) {
  const { rows } = await client.query(
    'SELECT id, name, monthly_api_call_limit, monthly_token_limit FROM plans WHERE id = $1',
    [planId]
  );
  if (!rows[0]) {
    return null;
  }
  return {
    id: rows[0].id,
    name: rows[0].name,
    apiCallLimit: Number(rows[0].monthly_api_call_limit),
    tokenLimit: Number(rows[0].monthly_token_limit),
  };
}

module.exports = { findById };
