# Loop support — open questions and answers

Living record of the thread with Loop (`#workoutmeals-loop`, Varun Sehgal) about
getting a `Delivery-Date` onto subscription renewal orders. Background: Loop
auto-charge orders arrive without the checkout attributes and are dropped at
[webhooks.js:34](../src/routes/webhooks.js#L34).

## Context given to Loop

> We sell fresh food on a scheduled-delivery model. At checkout the customer
> picks a delivery date, time and location through a checkout UI extension,
> which writes cart attributes that land on the Shopify order as
> `note_attributes`: `Delivery-Date`, `Delivery-Time`, `Delivery-Location-Id`.
> A downstream service reads those to derive the pack date and production date,
> which drive our kitchen schedule.
>
> Orders created by Loop auto-charge don't go through checkout, so they arrive
> without those attributes and we can't schedule production for them. We need a
> way to get a delivery date onto every renewal order.

## Answered

**Upcoming-charge webhook — YES.** Loop emits `order/upcoming`, triggered based
on upcoming order preferences, configured under **Settings → Notifications →
Preferences**. *Still unconfirmed whether this is an HTTP webhook to our
endpoint — but Loop have since referenced `order/processed` as a webhook, so
they do run real HTTP webhooks. See W1.*

**Next charge date via API — YES.** `nextBillingDateEpoch` (Unix epoch,
timezone-unambiguous) on subscription reads, plus ISO 8601 `nextBillingDate`
(UTC, Z-suffixed).

**Writing custom attributes — YES.** Loop provide APIs to update the order note,
update an existing custom attribute, and add a new custom attribute. Changes are
reflected in Loop immediately, and appear on the Shopify order page for **orders
created after the update**. Already-processed orders are not retroactively
updated on Shopify.

**Identifying Loop-created orders — YES.** Shopify's `orders/create` payload
carries `app_id`, which identifies the app that created the order. Loop's
`order/processed` webhook carries `id` = Loop's own order id.

## Loop's counter-questions and our answers

### "What exact data in a subscription are you referring to update?"

Three custom key/value fields — the same keys our checkout extension writes onto
one-off orders:

| Key | Example | Meaning |
| --- | --- | --- |
| `Delivery-Date` | `2026-08-14` | date the box should be delivered |
| `Delivery-Time` | `6am - 10am` | delivery window |
| `Delivery-Location-Id` | `2000` | postcode / delivery zone used for routing |

`Delivery-Date` changes every cycle — derived from the charge date and our
production calendar — so it must be writable before each renewal.

### "What order attribute do you want to modify?"

`note_attributes` on the Shopify order — the "Additional details" custom
attributes — adding the three keys above. Nothing else.

### "We are unable to understand the ask here" (subscription↔order identifier)

We need a field on the renewal order payload identifying **which subscription**
produced it — not merely which app. `app_id` only tells us Loop created the
order. A customer with two active subscriptions produces two renewals with the
same `app_id` and different required delivery dates.

## Open

- **W1** Is `order/upcoming` an HTTP webhook POSTed to an endpoint we host?
  Where do we register the URL and how do we verify the signature?
- **W2 (critical)** How far in advance does `order/upcoming` fire? Configurable?
  Determines whether we have time to compute and write before the charge.
- **W3** Payload contents — subscription id, customer, shipping address, line
  items, scheduled charge date?
- **A3 (critical)** Is a custom attribute stored against the **subscription**
  (applies to all future orders) or against a **specific upcoming order**? Our
  `Delivery-Date` differs every cycle, so we need per-cycle values.
- **A4 (critical)** How close to the charge can we write and still have the value
  land on the created order? Is there a lock/freeze point?
- **A5** API docs for the custom-attribute endpoints — auth, rate limits. We'd
  write for a large number of subscriptions each cycle.
- **A6** Does the attribute arrive in Shopify `note_attributes` with our exact
  key and value unchanged?
- **I2** Does the `order/processed` payload carry the **subscription id** and the
  **Shopify order id** alongside Loop's order `id`? If all three, correlation is
  solved.
- **R1** If a charge fails and Loop retries, does the retry create a new Shopify
  order id or reuse the same one? (`orders_to_enrich` has a unique index on
  `order_id`; a reused id would be swallowed by `ON CONFLICT DO NOTHING`.)

## Architecture implications

The custom-attribute API makes the **write-ahead** path viable, and it needs
**zero changes** to the existing enrichment pipeline:

1. `order/upcoming` fires for a subscription.
2. We compute the delivery date for that cycle.
3. We write `Delivery-Date` / `Delivery-Time` / `Delivery-Location-Id` via Loop's
   custom-attribute API.
4. Loop charges; the Shopify order is created carrying those attributes.
5. Shopify `orders/create` → existing webhook and queue handle it unchanged.

Viability rests entirely on **A3, A4 and W2** — per-cycle values, and enough
lead time between the notification and the charge to write them.

`app_id` is separately useful: it lets the webhook positively identify Loop
orders rather than inferring "no `Delivery-Date` ⇒ probably Loop", which is what
the `skipped`-status logging would otherwise rely on.
