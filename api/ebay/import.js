const ALLOWED_ORIGIN = process.env.DRIFTIT_ORIGIN || "*";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function config() {
  const sandbox =
    (process.env.EBAY_ENVIRONMENT || "sandbox").toLowerCase() === "sandbox";

  return {
    base: sandbox
      ? "https://api.sandbox.ebay.com"
      : "https://api.ebay.com",
    marketplace: "EBAY_US"
  };
}

function itemId(input) {
  const s = String(input || "").trim();

  if (/^\d{9,15}$/.test(s)) return s;

  try {
    const u = new URL(s);

    const m = u.pathname.match(
      /\/itm\/(?:[^/]+\/)?(\d{9,15})(?:\/|$)/i
    );

    if (m) return m[1];

    const q = u.searchParams.get("item");

    if (q && /^\d{9,15}$/.test(q)) {
      return q;
    }
  } catch {}

  return null;
}

async function getToken(base, clientId, clientSecret) {
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
    throw new Error(
      data.error_description ||
      data.error ||
      `eBay OAuth failed: HTTP ${response.status}`
    );
  }

  return data.access_token;
}

async function getListing(
  base,
  marketplace,
  accessToken,
  legacyId
) {
  const url =
    `${base}/buy/browse/v1/item/get_item_by_legacy_id` +
    `?legacy_item_id=${encodeURIComponent(legacyId)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
      Accept: "application/json"
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.errors?.[0]?.longMessage ||
      data?.errors?.[0]?.message ||
      `eBay Browse API failed: HTTP ${response.status}`;

    throw new Error(message);
  }

  return data;
}

module.exports = async function handler(req, res) {

  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Use POST."
    });
  }

  const clientId =
    process.env.EBAY_CLIENT_ID;

  const clientSecret =
    process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({
      error:
        "Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET."
    });
  }

  const input =
    req.body?.url ||
    req.body?.itemUrl ||
    req.body?.itemURL ||
    req.body?.itemId ||
    req.body?.legacyItemId;

  const legacyId = itemId(input);

  if (!legacyId) {
    return res.status(400).json({
      error:
        "Paste a valid eBay URL or numeric eBay item ID."
    });
  }

  try {

    const ebay = config();

    const accessToken =
      await getToken(
        ebay.base,
        clientId,
        clientSecret
      );

    const item =
      await getListing(
        ebay.base,
        ebay.marketplace,
        accessToken,
        legacyId
      );

    const additionalImages =
      Array.isArray(item.additionalImages)
        ? item.additionalImages
            .map(img => img.imageUrl)
            .filter(Boolean)
        : [];

    const mainImage =
      item.image?.imageUrl ||
      additionalImages[0] ||
      "";

    const images =
      [mainImage, ...additionalImages]
        .filter(Boolean)
        .filter(
          (value, index, array) =>
            array.indexOf(value) === index
        );

    return res.status(200).json({

      id:
        item.itemId ||
        `EBAY-${legacyId}`,

      legacyId,

      title:
        item.title ||
        `eBay Item ${legacyId}`,

      price:
        item.price
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
        mainImage,

      images,

      itemWebUrl:
        item.itemWebUrl || "",

      category:
        item.categoryPath || "",

      environment:
        (process.env.EBAY_ENVIRONMENT || "sandbox")
          .toLowerCase()

    });

  } catch (error) {

    console.error(
      "DRIFTiT eBay importer error:",
      error
    );

    return res.status(502).json({

      error:
        error?.message ||
        "Unable to import the eBay listing.",

      environment:
        (process.env.EBAY_ENVIRONMENT || "sandbox")
          .toLowerCase()

    });
  }
};
