const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichFromHds } = require('../src/lib/enrich');

test('passes extra parameters to HDS and captures additional response fields', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const target = new URL(url, 'https://example.test');
    assert.equal(target.searchParams.get('postcode'), '3000');
    assert.equal(target.searchParams.get('suburb'), 'Brunswick');
    assert.equal(target.searchParams.get('source'), 'checkout');
    assert.equal(options.headers.Accept, 'application/json');

    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        serviceable: true,
        region: { name: 'Melbourne' },
        suburb: { name: 'Brunswick', postcode: '3000' },
        delivery_options: [
          {
            delivery_date: '2025-01-21',
            pack_date: '2025-01-19',
            production_date: '2025-01-17',
            service_name: 'Express',
            fee: 5.5,
            extra_flag: true,
          },
        ],
      }),
    };
  };

  try {
    const result = await enrichFromHds({
      postcode: '3000',
      suburb: 'Brunswick',
      deliveryDate: '2025-01-21',
      additionalParams: { source: 'checkout' },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data.hds_additional_parameters, {
      service_name: 'Express',
      fee: 5.5,
      extra_flag: true,
    });
    assert.equal(result.data.hds_response?.matched_option?.service_name, 'Express');
  } finally {
    global.fetch = originalFetch;
  }
});
