# Client update email — draft

Short status update covering the order enrichment service and the Loop
subscription work. Adjust the "built" wording if it's already deployed.

---

**Subject:** HDS Delivery Data — Progress Update

Hi [Name],

A quick update on the delivery data work.

## 1. Order enrichment — done

I've built a service that attaches HDS delivery information to every order after
it's placed. It picks up the delivery date, time and location the customer chose
at checkout, looks them up in the existing HDS system, and stores the pack date,
production date, region, suburb and postcode against the order.

It runs in the background, so it never slows down or blocks checkout — the order
is confirmed straight away and the delivery details are added moments later. If
a lookup fails it retries automatically, and anything unresolved is logged with
the reason so nothing goes missing.

Because it reads from the same HDS system the checkout uses, the stored pack and
production dates always match what the customer was shown. Everything is saved
in the HDS database, so it can be reported on by region and date for kitchen
planning.

## 2. Loop subscriptions — in progress

Subscription renewals don't go through checkout — Loop charges the customer and
creates the order automatically — so those orders arrive with no delivery date
and can't be scheduled for production.

I've raised this with Loop's support team. They've confirmed they can notify us
before an upcoming charge, and that their API gives us each subscription's next
charge date, so we can work out the right delivery date in advance.

They still owe us a few answers: whether we can store the delivery date on the
subscription so Loop applies it to each renewal, how far ahead the notification
is sent, and how a renewal order can be linked back to its subscription.

Once they confirm, I'll implement it. The enrichment service already handles
everything else, so subscription renewals are the only remaining gap.

Happy to walk through it or demo the service if useful.

Best regards,
[Your name]

---

**Before sending:** if the service is already live on production, change "done"
to "live" and add the go-live date.
