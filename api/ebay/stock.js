const EPN_CAMPAIGN_ID = "5339217456";
const SELLER = "driftitautoparts";
const ALLOWED_ORIGIN = process.env.DRIFTIT_ORIGIN || "*";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function getToken() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing eBay credentials.");
  }

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope"
  });

  const response = await fetch(
    "https://api.ebay.com/identity/v1/oauth2/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
      data.error ||
      "eBay OAuth failed."
    );
  }

  return data.access_token;
}

function getLegacyId(item) {
  const itemIdMatch = String(item.itemId || "").match(
    /\|(\d{9,15})\|/
  );

  if (itemIdMatch) {
    return itemIdMatch[1];
  }

  const urlMatch = String(item.itemWebUrl || "").match(
    /\/itm\/(?:[^/]+\/)?(\d{9,15})/
  );

  return urlMatch ? urlMatch[1] : "";
}

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Use GET."
    });
  }

  try {
    const accessToken = await getToken();

    const customId = "DRIFTIT-STOCK";

    const params = new URLSearchParams({
      q: "*",
      filter: `sellers:{${SELLER}}`,
      sort: "newlyListed",
      limit: "12"
    });

    const response = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",

          "X-EBAY-C-ENDUSERCTX":
            `affiliateCampaignId=${EPN_CAMPAIGN_ID},` +
            `affiliateReferenceId=${customId}`,

          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const message =
        data?.errors?.[0]?.longMessage ||
        data?.errors?.[0]?.message ||
        `eBay search failed: ${response.status}`;

      throw new Error(message);
    }

    const items = (data.itemSummaries || [])
      .map(item => {
        const legacyId = getLegacyId(item);

        const images = [
          item.image?.imageUrl,
          ...(item.thumbnailImages || []).map(
            image => image.imageUrl
          )
        ]
          .filter(Boolean)
          .filter(
            (value, index, array) =>
              array.indexOf(value) === index
          );

        return {
          id: item.itemId || legacyId,

          legacyId,

          title:
            item.title ||
            `DRIFTiT eBay Item ${legacyId}`,

          price: item.price
            ? `${item.price.value} ${item.price.currency}`
            : "View current price on eBay",

          priceValue:
            item.price?.value || null,

          currency:
            item.price?.currency || null,

          condition:
            item.condition || "",

          seller:
            item.seller?.username || SELLER,

          image:
            item.image?.imageUrl || "",

          images,

          itemWebUrl:
            item.itemWebUrl || "",

          itemAffiliateWebUrl:
            item.itemAffiliateWebUrl || "",

          environment: "production"
        };
      })

      // Never display our old Sandbox test listing.
      .filter(
        item =>
          item.legacyId !== "110590958349"
      );

    return res.status(200).json({
      success: true,
      seller: SELLER,
      count: items.length,
      items
    });

  } catch (error) {
    console.error(
      "DRIFTiT stock error:",
      error
    );

    return res.status(502).json({
      success: false,
      error:
        error?.message ||
        "Unable to load DRIFTiT stock."
    });
  }
};
