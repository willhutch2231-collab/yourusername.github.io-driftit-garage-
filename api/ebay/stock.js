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
      `eBay OAuth failed: HTTP ${response.status}`
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

function ebayHeaders(accessToken, legacyId = "STOCK") {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    "X-EBAY-C-ENDUSERCTX":
      `affiliateCampaignId=${EPN_CAMPAIGN_ID},` +
      `affiliateReferenceId=DRIFTIT-${legacyId}`,
    Accept: "application/json"
  };
}

/*
  Fetch the FULL eBay listing.

  This is important because the search endpoint only returns
  summary image information. The detailed item endpoint gives
  us the primary image plus additionalImages.
*/
async function getFullItem(accessToken, legacyId) {
  const params = new URLSearchParams({
    legacy_item_id: legacyId
  });

  const response = await fetch(
    `https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?${params.toString()}`,
    {
      method: "GET",
      headers: ebayHeaders(accessToken, legacyId)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error(
      `Could not retrieve full eBay item ${legacyId}:`,
      data
    );

    return null;
  }

  return data;
}

function buildImages(fullItem, summaryItem) {
  /*
    DO NOT use thumbnailImages here.

    thumbnailImages can contain a smaller version of the
    primary image, which is why the site was showing:

      Photo 1 = low-resolution main image
      Photo 2 = high-resolution main image

    Instead, use:
      1. Full-size primary image
      2. Full-size additionalImages
  */

  const images = [
    fullItem?.image?.imageUrl,

    ...(Array.isArray(fullItem?.additionalImages)
      ? fullItem.additionalImages.map(
          image => image.imageUrl
        )
      : [])
  ].filter(Boolean);

  /*
    Exact duplicate protection.
  */
  const uniqueImages = [
    ...new Set(images)
  ];

  /*
    If detailed item lookup somehow doesn't return images,
    fall back to the search result's main image.

    We intentionally DO NOT use thumbnailImages.
  */
  if (
    uniqueImages.length === 0 &&
    summaryItem?.image?.imageUrl
  ) {
    uniqueImages.push(
      summaryItem.image.imageUrl
    );
  }

  return uniqueImages;
}

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Use GET."
    });
  }

  try {
    const accessToken = await getToken();

    /*
      STEP 1:
      Find all active DRIFTiT listings.
    */
    const params = new URLSearchParams({
      category_ids: "6030",
      filter: `sellers:{${SELLER}}`,
      sort: "newlyListed",
      limit: "12"
    });

    const response = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`,
      {
        method: "GET",
        headers: ebayHeaders(
          accessToken,
          "STOCK"
        )
      }
    );

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.errors?.[0]?.longMessage ||
        data?.errors?.[0]?.message ||
        `eBay search failed: HTTP ${response.status}`;

      throw new Error(message);
    }

    /*
      STEP 2:
      Remove invalid/test listings before making
      the detailed API calls.
    */
    const summaries = (
      data.itemSummaries || []
    )
      .map(item => ({
        item,
        legacyId: getLegacyId(item)
      }))

      .filter(x => x.legacyId)

      .filter(
        x =>
          x.legacyId !==
          "110590958349"
      );

    /*
      STEP 3:
      Retrieve complete information for every listing.

      Promise.all allows these requests to happen
      concurrently instead of one at a time.
    */
    const detailedItems =
      await Promise.all(
        summaries.map(async entry => {
          const fullItem =
            await getFullItem(
              accessToken,
              entry.legacyId
            );

          return {
            summary: entry.item,
            full: fullItem,
            legacyId: entry.legacyId
          };
        })
      );

    /*
      STEP 4:
      Build the response used by DRIFTiT.
    */
    const items = detailedItems.map(
      ({
        summary,
        full,
        legacyId
      }) => {

        const source =
          full || summary;

        const images =
          buildImages(
            full,
            summary
          );

        return {
          id:
            source.itemId ||
            summary.itemId ||
            `EBAY-${legacyId}`,

          legacyId,

          title:
            source.title ||
            summary.title ||
            `DRIFTiT eBay Item ${legacyId}`,

          price: source.price
            ? `${source.price.value} ${source.price.currency}`
            : summary.price
              ? `${summary.price.value} ${summary.price.currency}`
              : "View current price on eBay",

          priceValue:
            source.price?.value ||
            summary.price?.value ||
            null,

          currency:
            source.price?.currency ||
            summary.price?.currency ||
            null,

          condition:
            source.condition ||
            summary.condition ||
            "",

          conditionId:
            source.conditionId ||
            summary.conditionId ||
            "",

          seller:
            source.seller?.username ||
            summary.seller?.username ||
            SELLER,

          /*
            Main product image is now the first
            FULL-SIZE image.
          */
          image:
            images[0] || "",

          /*
            Actual eBay gallery.
          */
          images,

          itemWebUrl:
            source.itemWebUrl ||
            summary.itemWebUrl ||
            "",

          itemAffiliateWebUrl:
            source.itemAffiliateWebUrl ||
            summary.itemAffiliateWebUrl ||
            "",

          category:
            source.categoryPath ||
            source.category?.categoryName ||
            summary.categories?.[0]
              ?.categoryName ||
            "",

          /*
            Useful for testing.
          */
          imageCount:
            images.length,

          environment:
            "production"
        };
      }
    );

    return res.status(200).json({
      success: true,

      seller: SELLER,

      count: items.length,

      items
    });

  } catch (error) {
    console.error(
      "DRIFTiT automatic stock error:",
      error
    );

    return res.status(502).json({
      success: false,

      seller: SELLER,

      error:
        error?.message ||
        "Unable to load DRIFTiT stock."
    });
  }
};
