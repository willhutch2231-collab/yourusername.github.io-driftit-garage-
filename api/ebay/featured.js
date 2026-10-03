const EPN_CAMPAIGN_ID = "5339217456";
const REDIS_KEY = "driftit:featured-ebay-listings";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/* -----------------------------
   REDIS
----------------------------- */

function getRedisConfig() {
  const url = process.env.DRIFTIT_REDIS_KV_REST_API_URL;
  const token = process.env.DRIFTIT_REDIS_KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error("Missing DRIFTiT Redis environment variables.");
  }

  return {
    url: url.replace(/\/$/, ""),
    token
  };
}

async function redisCommand(command) {
  const { url, token } = getRedisConfig();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(data.error || `Redis request failed: HTTP ${response.status}`);
  }

  return data.result;
}

async function getFeaturedIds() {
  const result = await redisCommand(["SMEMBERS", REDIS_KEY]);

  return Array.isArray(result)
    ? result.map(String).filter(Boolean)
    : [];
}

async function addFeaturedId(id) {
  return redisCommand(["SADD", REDIS_KEY, String(id)]);
}

async function removeFeaturedId(id) {
  return redisCommand(["SREM", REDIS_KEY, String(id)]);
}

/* -----------------------------
   EBAY
----------------------------- */

async function getEbayToken() {
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
      `eBay OAuth failed: HTTP ${response.status}`
    );
  }

  return data.access_token;
}

function extractLegacyId(value) {
  const text = String(value || "").trim();

  // Plain eBay item number
  if (/^\d{9,15}$/.test(text)) {
    return text;
  }

  // Browse API format:
  // v1|188712194608|0
  const browseMatch = text.match(/\|(\d{9,15})\|/);

  if (browseMatch) {
    return browseMatch[1];
  }

  // Standard eBay listing URL
  const urlMatch = text.match(
    /\/itm\/(?:[^/?#]+\/)?(\d{9,15})/
  );

  if (urlMatch) {
    return urlMatch[1];
  }

  // Fallback for URLs containing item=
  const itemParam = text.match(
    /[?&](?:item|itemid)=(\d{9,15})/i
  );

  if (itemParam) {
    return itemParam[1];
  }

  return "";
}

async function getEbayItem(legacyId, accessToken) {
  const response = await fetch(
    `https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(
      legacyId
    )}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",

        // This tells eBay to generate our EPN affiliate URL.
        "X-EBAY-C-ENDUSERCTX":
          `affiliateCampaignId=${EPN_CAMPAIGN_ID},` +
          `affiliateReferenceId=DRIFTIT-${legacyId}`,

        Accept: "application/json"
      }
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.errors?.[0]?.longMessage ||
      data?.errors?.[0]?.message ||
      `Could not load eBay item ${legacyId}.`;

    throw new Error(message);
  }

  return normalizeItem(data, legacyId);
}

function normalizeItem(item, legacyId) {
  const images = [
    item.image?.imageUrl,

    ...(Array.isArray(item.additionalImages)
      ? item.additionalImages.map(image => image.imageUrl)
      : []),

    ...(Array.isArray(item.thumbnailImages)
      ? item.thumbnailImages.map(image => image.imageUrl)
      : [])
  ]
    .filter(Boolean)
    .filter(
      (value, index, array) =>
        array.indexOf(value) === index
    );

  return {
    id: item.itemId || `EBAY-${legacyId}`,

    legacyId,

    title:
      item.title ||
      `eBay Item ${legacyId}`,

    price: item.price
      ? `${item.price.value} ${item.price.currency}`
      : "View current price on eBay",

    priceValue:
      item.price?.value || null,

    currency:
      item.price?.currency || null,

    condition:
      item.condition || "",

    conditionId:
      item.conditionId || "",

    seller:
      item.seller?.username || "",

    image:
      item.image?.imageUrl ||
      images[0] ||
      "",

    images,

    itemWebUrl:
      item.itemWebUrl || "",

    itemAffiliateWebUrl:
      item.itemAffiliateWebUrl || "",

    category:
      item.categoryPath || "",

    environment:
      "production"
  };
}

/* -----------------------------
   LOAD ALL FEATURED ITEMS
----------------------------- */

async function loadFeaturedItems() {
  const ids = await getFeaturedIds();

  if (!ids.length) {
    return [];
  }

  const token = await getEbayToken();

  const results = await Promise.allSettled(
    ids.map(id => getEbayItem(id, token))
  );

  return results
    .filter(result => result.status === "fulfilled")
    .map(result => result.value)

    // DRIFTiT's own inventory belongs in
    // "Parts from our garage", not Featured.
    .filter(
      item =>
        String(item.seller || "").toLowerCase() !==
        "driftitautoparts"
    );
}

/* -----------------------------
   API HANDLER
----------------------------- */

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {

    /* -------------------------
       GET
       Load Featured Inventory
    ------------------------- */

    if (req.method === "GET") {
      const items = await loadFeaturedItems();

      return res.status(200).json({
        success: true,
        count: items.length,
        items
      });
    }

    /* -------------------------
       POST
       Add Featured Listing
    ------------------------- */

    if (req.method === "POST") {
      const supplied =
        req.body?.url ||
        req.body?.itemUrl ||
        req.body?.itemId ||
        req.body?.legacyId ||
        "";

      const legacyId = extractLegacyId(supplied);

      if (!legacyId) {
        return res.status(400).json({
          success: false,
          error:
            "Enter a valid eBay listing URL or item number."
        });
      }

      // Check the item with eBay BEFORE saving it.
      const token = await getEbayToken();

      const item = await getEbayItem(
        legacyId,
        token
      );

      // Never put our own inventory into
      // Featured eBay Inventory.
      if (
        String(item.seller || "").toLowerCase() ===
        "driftitautoparts"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "This is DRIFTiT GARAGE inventory. It is automatically displayed under Parts from our garage."
        });
      }

      await addFeaturedId(legacyId);

      return res.status(200).json({
        success: true,
        message:
          "Listing added to Featured eBay Inventory.",
        item
      });
    }

    /* -------------------------
       DELETE
       Remove Featured Listing
    ------------------------- */

    if (req.method === "DELETE") {
      const supplied =
        req.body?.itemId ||
        req.body?.legacyId ||
        req.query?.itemId ||
        req.query?.legacyId ||
        "";

      const legacyId = extractLegacyId(supplied);

      if (!legacyId) {
        return res.status(400).json({
          success: false,
          error:
            "A valid eBay item ID is required."
        });
      }

      await removeFeaturedId(legacyId);

      return res.status(200).json({
        success: true,
        message: `Listing ${legacyId} removed from Featured eBay Inventory.`,
        legacyId
      });
    }

    return res.status(405).json({
      success: false,
      error: "Method not allowed."
    });

  } catch (error) {
    console.error(
      "Featured eBay Inventory error:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Featured Inventory request failed."
    });
  }
};
