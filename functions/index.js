// functions/index.js

// --- Firebase Functions v2 (callable) ---
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
setGlobalOptions({ region: "europe-west2" });

const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { Storage } = require("@google-cloud/storage");

admin.initializeApp();
const storage = new Storage();

// Secret pulled from Secret Manager at runtime (DO NOT hardcode keys)
const stripeSecret = defineSecret("STRIPE_API_SECRET");

// ------------------------------------------------------------------
// #1 createCheckoutSession : builds a Stripe Checkout Session
// ------------------------------------------------------------------
exports.createCheckoutSession = onCall(
  { secrets: [stripeSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in to make a purchase.");
    }

    // Initialise Stripe with the secret value at **runtime**
    const stripe = require("stripe")(stripeSecret.value());

    // payload from the client
    const { beatId, leaseType, priceInCents, songName } = request.data;

    // Your **real** storefront base URL (GitHub Pages is fine if it’s the URL you really serve)
    const siteUrl = "https://pikkdh13.github.io/dreamhive-drill-beats";

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",

        // include the session id so the client can pull it back after redirect
        success_url: `${siteUrl}?purchase_success=true&session_id={CHECKOUT_SESSION_ID}`,
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

        // keep the bits we need to validate later
        metadata: {
          userId: request.auth.uid,
          beatId,
          leaseType,
        },
      });

      return { id: session.id };
    } catch (error) {
      console.error("Stripe Error (createCheckoutSession):", error);
      throw new HttpsError("internal", "Unable to create Stripe checkout session.");
    }
  }
);

// ------------------------------------------------------------------
// #2 getDownloadLink : verifies payment + returns a signed URL
// ------------------------------------------------------------------
exports.getDownloadLink = onCall(
  { secrets: [stripeSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const stripe = require("stripe")(stripeSecret.value());

    // the client must pass back the sessionId it got on success redirect
    const { sessionId } = request.data;
    if (!sessionId) {
      throw new HttpsError("invalid-argument", "Missing sessionId.");
    }

    // Pull the session from Stripe to verify payment + metadata
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      throw new HttpsError("failed-precondition", "Payment not completed.");
    }

    const { beatId, leaseType, userId } = session.metadata || {};
    if (!beatId || !leaseType || !userId) {
      throw new HttpsError("internal", "Missing purchase metadata.");
    }
    if (userId !== request.auth.uid) {
      throw new HttpsError("permission-denied", "User mismatch.");
    }

    // --- Storage: use your project’s bucket in the EU region ---
    // NOTE: this is the *Storage* bucket name, not Functions host.
    const bucket = storage.bucket("europe-west2-dream-hive-uk-drill-beats.appspot.com");

    // We expect: deliverables/{beatId}/{leaseType}.zip (e.g. deliverables/last-requests/mp3.zip)
    const filePath = `deliverables/${beatId}/${leaseType}.zip`;
    const file = bucket.file(filePath);

    const [exists] = await file.exists();
    if (!exists) {
      console.error(`File not found: ${filePath}`);
      throw new HttpsError("not-found", "Deliverable not found on server.");
    }

    // Short-lived, signed URL (10 minutes)
    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 10 * 60 * 1000,
      version: "v4",
    });

    // If you want to mark exclusives as sold in Firestore:
    if (leaseType === "exclusive") {
      const db = admin.firestore();
      const beatRef = db.doc(`beats/${beatId}`);
      await beatRef.set({ isSold: true }, { merge: true });
    }

    return { downloadUrl: url };
  }
);
