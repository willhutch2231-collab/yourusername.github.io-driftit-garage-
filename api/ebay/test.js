module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Use GET."
    });
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const environment =
    (process.env.EBAY_ENVIRONMENT || "sandbox").toLowerCase();

  if (!clientId || !clientSecret) {
    return res.status(500).json({
      success: false,
      environment,
      error: "Missing eBay environment variables."
    });
  }

  const base =
    environment === "sandbox"
      ? "https://api.sandbox.ebay.com"
      : "https://api.ebay.com";

  try {
    const credentials = Buffer.from(
      `${clientId}:${clientSecret}`
    ).toString("base64");

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope"
    });

    const response = await fetch(
      `${base}/identity/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.access_token) {
      return res.status(502).json({
        success: false,
        environment,
        status: response.status,
        error:
          data.error_description ||
          data.error ||
          "eBay did not return an access token."
      });
    }

    return res.status(200).json({
      success: true,
      environment,
      message: "eBay OAuth connected successfully",
      tokenType: data.token_type || "Application Access Token",
      expiresIn: data.expires_in || null
    });

  } catch (error) {
    console.error("eBay OAuth test error:", error);

    return res.status(500).json({
      success: false,
      environment,
      error:
        error?.message ||
        "Unable to connect to eBay."
    });
  }
};
