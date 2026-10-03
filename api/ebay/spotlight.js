const FEATURED_KEY = "driftit:spotlight-ebay-item";

const EPN_CAMPAIGN_ID = "5339217456";
const MARKETPLACE_ID = "EBAY_US";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function extractLegacyId(value = "") {
  const input = String(value).trim();

  // Plain eBay item number
  if (/^\d{9,15}$/.test(input)) return input;

  // Standard /itm/123456789 URL
  const itmMatch = input.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,15})/i);
  if (itmMatch) return itmMatch[1];

  // item=123456789 style
  const itemMatch = input.match(/[?&]item=(\d{9,15})/i);
  if (itemMatch) return itemMatch[1];

  return null;
}

async function getEbayToken() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing eBay API credentials.");
  }

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(
    "https://api.ebay.com/identity/v1/oauth2/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body:
        "grant_type=client_credentials&scope=" +
        encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
      data.error ||
      "Unable to obtain eBay access token."
    );
  }

  return data.access_token;
}

async function redis(command) {
  const redisUrl =
    process.env.DRIFTIT_REDIS_KV_REST_API_URL;

  const redisToken =
    process.env.DRIFTIT_REDIS_KV_REST_API_TOKEN;

  if (!redisUrl || !redisToken) {
    throw new Error("Redis environment variables are missing.");
  }

  const response = await fetch(redisUrl.replace(/\/$/, ""), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error || "Redis request failed."
    );
  }

  return data.result;
}

async function getEbayItem(legacyId) {
  const token = await getEbayToken();

  const url =
    "https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id" +
    `?legacy_item_id=${encodeURIComponent(legacyId)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,

      // DRIFTiT EPN tracking
      "X-EBAY-C-ENDUSERCTX":
        `affiliateCampaignId=${EPN_CAMPAIGN_ID},` +
        `affiliateReferenceId=DRIFTIT-${legacyId}`,
    },
  });

  const item = await response.json();

  if (!response.ok) {
    throw new Error(
      item?.errors?.[0]?.message ||
      "Unable to retrieve eBay listing."
    );
  }

  const images = [
    item?.image?.imageUrl,

    ...(Array.isArray(item?.additionalImages)
      ? item.additionalImages.map(
          (image) => image.imageUrl
        )
      : []),
  ].filter(Boolean);

  const uniqueImages = [...new Set(images)];

  return {
    legacyId,

    title:
      item.title ||
      "Featured eBay Listing",

    price:
      item.price?.value && item.price?.currency
        ? `${item.price.value} ${item.price.currency}`
        : "",

    priceValue:
      item.price?.value || "",

    currency:
      item.price?.currency || "",

    condition:
      item.condition || "",

    seller:
      item.seller?.username || "",

    image:
      uniqueImages[0] || "",

    images: uniqueImages,

    imageCount: uniqueImages.length,

    itemWebUrl:
      item.itemWebUrl || "",

    itemAffiliateWebUrl:
      item.itemAffiliateWebUrl ||
      item.itemWebUrl ||
      "",

    epnCampaignId:
      EPN_CAMPAIGN_ID,

    epnCustomId:
      `DRIFTIT-${legacyId}`,
  };
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {

    // --------------------------------
    // GET CURRENT FEATURED ITEM
    // --------------------------------

    if (req.method === "GET") {
      const legacyId = await redis([
        "GET",
        FEATURED_KEY,
      ]);

      if (!legacyId) {
        return res.status(200).json({
          ok: true,
          item: null,
        });
      }

      try {
        const item = await getEbayItem(
          String(legacyId)
        );

        return res.status(200).json({
          ok: true,
          item,
        });

      } catch (error) {

        return res.status(200).json({
          ok: true,
          item: null,
          unavailable: true,
          legacyId: String(legacyId),
        });
      }
    }


    // --------------------------------
    // CHANGE FEATURED ITEM
    // --------------------------------

    if (req.method === "POST") {
      const input =
        req.body?.url ||
        req.body?.itemId ||
        req.body?.legacyId ||
        "";

      const legacyId = extractLegacyId(input);

      if (!legacyId) {
        return res.status(400).json({
          ok: false,
          error:
            "Enter a valid eBay listing URL or item number.",
        });
      }

      // Verify the listing exists before saving it
      const item = await getEbayItem(legacyId);

      await redis([
        "SET",
        FEATURED_KEY,
        legacyId,
      ]);

      return res.status(200).json({
        ok: true,
        saved: true,
        item,
      });
    }


    // --------------------------------
    // REMOVE FEATURED ITEM
    // --------------------------------

    if (req.method === "DELETE") {
      await redis([
        "DEL",
        FEATURED_KEY,
      ]);

      return res.status(200).json({
        ok: true,
        removed: true,
      });
    }


    return res.status(405).json({
      ok: false,
      error: "Method not allowed.",
    });

  } catch (error) {
    console.error("Spotlight API error:", error);

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Something went wrong.",
    });
  }
}
