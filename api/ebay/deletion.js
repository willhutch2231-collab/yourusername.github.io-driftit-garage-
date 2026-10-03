const crypto = require("crypto");

const ENDPOINT =
  "https://yourusernamegithubio-driftit-garage.vercel.app/api/ebay/deletion";

module.exports = async function handler(req, res) {
  // eBay endpoint verification
  if (req.method === "GET") {
    const challengeCode = req.query.challenge_code;
    const verificationToken = process.env.EBAY_VERIFICATION_TOKEN;

    if (!challengeCode || !verificationToken) {
      return res.status(400).json({
        error: "Missing challenge code or verification token."
      });
    }

    const challengeResponse = crypto
      .createHash("sha256")
      .update(challengeCode)
      .update(verificationToken)
      .update(ENDPOINT)
      .digest("hex");

    res.setHeader("Content-Type", "application/json");

    return res.status(200).json({
      challengeResponse
    });
  }

  // eBay marketplace account deletion notification
  if (req.method === "POST") {
    console.log(
      "eBay Marketplace Account Deletion notification received",
      req.body
    );

    // DRIFTiT currently has no eBay-user data deletion database
    // connected here. Acknowledge receipt.
    return res.status(200).json({
      received: true
    });
  }

  return res.status(405).json({
    error: "Method not allowed."
  });
};
