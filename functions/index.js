const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
// --- THIS IS THE FIX ---
// I am so sorry I missed this.
const {defineSecret} = require("firebase-functions/params"); 
const admin = require("firebase-admin");
const {Storage} = require("@google-cloud/storage");

setGlobalOptions({region: "europe-west2"});
admin.initializeApp();
const storage = new Storage();

const stripeSecret = defineSecret("STRIPE_API_KEY");

exports.createCheckoutSession = onCall({secrets: [stripeSecret]}, async (request) => {
  const stripe = require("stripe")(stripeSecret.value());
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }

  const {beatId, leaseType, priceInCents, songName} = request.data;
  const siteUrl = "https://pikkdh13.github.io/dreamhive-drill-beats";

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      success_url: `${siteUrl}?purchase_success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}?purchase_canceled=true`,
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: priceInCents,
          product_data: {
            name: `${songName} (${leaseType} Lease)`,
            description: `Beat ID: ${beatId}`,
          },
        },
        quantity: 1,
      }],
      metadata: {
        userId: request.auth.uid,
        beatId: beatId,
        leaseType: leaseType,
      },
    });
    return {id: session.id};
  } catch (error) {
    console.error("Stripe Error:", error);
    throw new HttpsError("internal", "Stripe Error.");
  }
});

// The getDownloadLink function is perfect and unchanged.
exports.getDownloadLink = onCall({secrets: [stripeSecret]}, async (request) => {
    const stripe = require("stripe")(stripeSecret.value());
    if (!request.auth) { throw new HttpsError("unauthenticated", "You must be logged in."); }
    const {sessionId} = request.data;
    if (!sessionId) { throw new HttpsError("invalid-argument", "Missing sessionID."); }
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") { throw new HttpsError("failed-precondition", "Payment not completed."); }
    const {beatId, leaseType, userId} = session.metadata || {};
    if (!beatId || !leaseType || !userId) { throw new HttpsError("internal", "Missing purchase metadata."); }
    if (userId !== request.auth.uid) { throw new HttpsError("permission-denied", "User mismatch."); }
    const bucket = storage.bucket("dream-hive-uk-drill-beats.appspot.com");
    const filePath = `deliverables/${beatId}/${leaseType}.zip`;
    const file = bucket.file(filePath);
    const [exists] = await file.exists();
    if (!exists) {
        console.error(`File not found: ${filePath}`);
        throw new HttpsError("not-found", "Deliverable not found on server.");
    }
    const [url] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 10 * 60 * 1000,
        version: "v4",
    });
    if (leaseType === "exclusive") {
        const db = admin.firestore();
        const beatRef = db.doc(`beats/${beatId}`);
        await beatRef.set({isSold: true}, {merge: true});
    }
    return {downloadUrl: url};
});