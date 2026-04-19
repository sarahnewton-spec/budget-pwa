const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { createClient } = require('@supabase/supabase-js');
const { encrypt } = require('./_crypto');

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV],
  baseOptions: { headers: {
    'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
    'PLAID-SECRET': process.env.PLAID_SECRET,
  }},
}));

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const jwt = req.headers.authorization?.replace('Bearer ', '');
  if (!jwt) return res.status(401).json({ error: 'Unauthorized' });

  const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error } = await supa.auth.getUser();
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { public_token, institution_name } = req.body;
  if (!public_token) return res.status(400).json({ error: 'Missing public_token' });

  try {
    const { data } = await plaid.itemPublicTokenExchange({ public_token });
    await supa.from('plaid_items').upsert({
      user_id: user.id,
      access_token: encrypt(data.access_token),
      item_id: data.item_id,
      institution_name: institution_name || 'Bank',
      cursor: null,
    }, { onConflict: 'item_id' });
    res.json({ ok: true, item_id: data.item_id });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
};
