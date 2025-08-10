// functions/index.js
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
setGlobalOptions({ region: "europe-west2" });

const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
admin.initializeApp();

// Define the Stripe secret from Secret Manager (NOT a plain string param)
const stripeSecret = defineSecret("STRIPE_API_SECRET");

exports.createCheckoutSession = onCall(
  { secrets: [stripeSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in to make a purchase.");
    }

    // Pull the secret value at runtime and init Stripe
    const stripe = require("stripe")(stripeSecret.value());

    const { beatId, leaseType, priceInCents, songName } = request.data;
    const siteUrl = "https://pikkdh13.github.io"; // change later if needed

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        success_url: `${siteUrl}?purchase_success=true`,
        cancel_url: `${siteUrl}?purchase_canceled=true`,
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: priceInCents,
              product_data: {
                name: `${songName} (${leaseType} Lease)`,
                description: `Beat ID: ${beatId}`,
              },
            },
            quantity: 1,
          },
        ],
        metadata: {
          userId: request.auth.uid,
          beatId,
          leaseType,
        },
      });

      return { id: session.id };
    } catch (error) {
      console.error("Stripe Error:", error);
      throw new HttpsError("internal", "Unable to create Stripe checkout session.");
    }
  }
);
