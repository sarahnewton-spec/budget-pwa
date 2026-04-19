const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { createClient } = require('@supabase/supabase-js');

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV],
  baseOptions: { headers: {
    'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
    'PLAID-SECRET': process.env.PLAID_SECRET,
  }},
}));

// Maps Plaid personal_finance_category.detailed → app budget category
const DETAIL_MAP = {
  FOOD_AND_DRINK_GROCERIES: 'groceries',
  FOOD_AND_DRINK_SUPERMARKETS_AND_GROCERIES: 'groceries',
  FOOD_AND_DRINK_RESTAURANTS: 'takeout',
  FOOD_AND_DRINK_FAST_FOOD: 'takeout',
  FOOD_AND_DRINK_COFFEE: 'takeout',
  FOOD_AND_DRINK_FOOD_DELIVERY_SERVICES: 'takeout',
  TRANSPORTATION_GAS_AND_FUEL: 'gas',
  PERSONAL_CARE_HAIR_AND_BEAUTY: 'beauty',
  PERSONAL_CARE_DRUG_STORES_AND_PHARMACIES: 'beauty',
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'clothing',
  CLOTHING_AND_ACCESSORIES: 'clothing',
  GIFTS_AND_DONATIONS_CHARITABLE_GIVING: 'charity',
};

const PRIMARY_MAP = {
  FOOD_AND_DRINK: 'takeout',
  TRANSPORTATION: 'gas',
  PERSONAL_CARE: 'beauty',
  GENERAL_MERCHANDISE: 'misc',
  ENTERTAINMENT: 'misc',
  HOME_IMPROVEMENT: 'misc',
  MEDICAL: 'misc',
  TRAVEL: 'misc',
  RENT_AND_UTILITIES: 'misc',
  GENERAL_SERVICES: 'misc',
  GOVERNMENT_AND_NON_PROFIT: 'charity',
};

// Categories to skip entirely (not expenses)
const SKIP_PRIMARY = new Set(['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'BANK_FEES', 'LOAN_PAYMENTS']);

function categorize(txn, rules) {
  const merchant = (txn.merchant_name || txn.name || '').toLowerCase();
  const desc = (txn.name || '').toLowerCase();

  // 1. User rules first (ordered by priority desc)
  for (const rule of rules) {
    const haystack = rule.match_field === 'merchant_name' ? merchant : desc;
    if (haystack.includes(rule.pattern.toLowerCase())) {
      return { budget_category: rule.budget_category, status: 'auto' };
    }
  }

  // 2. Plaid detailed category
  const detailed = txn.personal_finance_category?.detailed?.replace(/[^A-Z_]/g, '_');
  if (detailed && DETAIL_MAP[detailed]) {
    return { budget_category: DETAIL_MAP[detailed], status: 'auto' };
  }

  // 3. Plaid primary category
  const primary = txn.personal_finance_category?.primary;
  if (primary && SKIP_PRIMARY.has(primary)) return null; // skip
  if (primary && PRIMARY_MAP[primary]) {
    return { budget_category: PRIMARY_MAP[primary], status: 'auto' };
  }

  return { budget_category: null, status: 'pending' };
}

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

  const { data: items } = await supa.from('plaid_items').select('*').eq('user_id', user.id);
  if (!items?.length) return res.json({ added: 0, pending: 0 });

  const { data: rules } = await supa.from('category_rules')
    .select('*').eq('user_id', user.id).order('priority', { ascending: false });

  let totalAdded = 0, totalPending = 0;

  for (const item of items) {
    let cursor = item.cursor;
    let hasMore = true;
    const toUpsert = [];

    while (hasMore) {
      const { data } = await plaid.transactionsSync({
        access_token: item.access_token,
        cursor: cursor || undefined,
        options: { include_personal_finance_category: true },
      });

      for (const txn of data.added) {
        if (txn.amount <= 0) continue; // skip credits/refunds
        const cat = categorize(txn, rules || []);
        if (!cat) continue; // skip income/transfers
        toUpsert.push({
          id: txn.transaction_id,
          user_id: user.id,
          date: txn.date,
          amount: txn.amount,
          merchant_name: txn.merchant_name || txn.name,
          plaid_category: txn.personal_finance_category?.detailed || txn.personal_finance_category?.primary || null,
          budget_category: cat.budget_category,
          status: cat.status,
          description: txn.name,
        });
        if (cat.status === 'pending') totalPending++;
        else totalAdded++;
      }

      cursor = data.next_cursor;
      hasMore = data.has_more;
    }

    if (toUpsert.length) {
      await supa.from('transactions').upsert(toUpsert, { onConflict: 'id', ignoreDuplicates: false });
    }
    await supa.from('plaid_items').update({ cursor }).eq('id', item.id);
  }

  res.json({ added: totalAdded, pending: totalPending });
};
