const EPN_CAMPAIGN_ID = "5339217456";
const SELLER = "driftitautoparts";
const ALLOWED_ORIGIN = process.env.DRIFTIT_ORIGIN || "*";

const HIDDEN_STOCK_KEY = "driftit:hidden-stock";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}


/*
  EBAY ACCESS TOKEN
*/
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


/*
  GET EBAY LEGACY ITEM ID
*/
function getLegacyId(item) {
  const itemIdMatch = String(
    item.itemId || ""
  ).match(/\|(\d{9,15})\|/);

  if (itemIdMatch) {
    return itemIdMatch[1];
  }

  const urlMatch = String(
    item.itemWebUrl || ""
  ).match(
    /\/itm\/(?:[^/]+\/)?(\d{9,15})/
  );

  return urlMatch
    ? urlMatch[1]
    : "";
}


/*
  EBAY REQUEST HEADERS
*/
function ebayHeaders(
  accessToken,
  legacyId = "STOCK"
) {
  return {
    Authorization: `Bearer ${accessToken}`,

    "X-EBAY-C-MARKETPLACE-ID":
      "EBAY_US",

    "X-EBAY-C-ENDUSERCTX":
      `affiliateCampaignId=${EPN_CAMPAIGN_ID},` +
      `affiliateReferenceId=DRIFTIT-${legacyId}`,

    Accept: "application/json"
  };
}


/*
  REDIS

  Get all eBay item IDs that have been removed
  from the DRIFTiT website.

  These listings remain completely untouched
  on eBay.
*/
async function getHiddenStockIds() {
  const redisUrl =
    process.env
      .DRIFTIT_REDIS_KV_REST_API_URL;

  const redisToken =
    process.env
      .DRIFTIT_REDIS_KV_REST_API_TOKEN;

  /*
    If Redis isn't configured, don't break
    the inventory page.
  */
  if (!redisUrl || !redisToken) {
    console.warn(
      "DRIFTiT Redis configuration missing. Hidden stock filtering disabled."
    );

    return [];
  }

  try {
    const response = await fetch(
      redisUrl.replace(/\/$/, ""),
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${redisToken}`,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify([
          "SMEMBERS",
          HIDDEN_STOCK_KEY
        ])
      }
    );

    const data =
      await response
        .json()
        .catch(() => ({}));

    if (!response.ok || data.error) {
      throw new Error(
        data.error ||
        `Redis HTTP ${response.status}`
      );
    }

    /*
      Always convert IDs to strings so
      comparison with eBay IDs is reliable.
    */
    return Array.isArray(data.result)
      ? data.result.map(String)
      : [];

  } catch (error) {
    /*
      We don't want Redis problems to take
      the entire inventory page offline.
    */
    console.error(
      "Could not load hidden DRIFTiT listings:",
      error
    );

    return [];
  }
}


/*
  FETCH COMPLETE EBAY LISTING

  The search endpoint only provides summary
  image information.

  This endpoint provides:
    - full-size primary image
    - additionalImages
*/
async function getFullItem(
  accessToken,
  legacyId
) {
  const params =
    new URLSearchParams({
      legacy_item_id: legacyId
    });

  const response = await fetch(
    `https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?${params.toString()}`,
    {
      method: "GET",

      headers:
        ebayHeaders(
          accessToken,
          legacyId
        )
    }
  );

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok) {
    console.error(
      `Could not retrieve full eBay item ${legacyId}:`,
      data
    );

    return null;
  }

  return data;
}


/*
  BUILD FULL-SIZE IMAGE GALLERY

  IMPORTANT:

  Do NOT use thumbnailImages.

  thumbnailImages can contain a low-resolution
  version of the primary photo and previously
  caused:

    Photo 1 = low resolution
    Photo 2 = same image high resolution
*/
function buildImages(
  fullItem,
  summaryItem
) {
  const images = [

    fullItem?.image?.imageUrl,

    ...(Array.isArray(
      fullItem?.additionalImages
    )
      ? fullItem.additionalImages.map(
          image =>
            image.imageUrl
        )
      : [])

  ].filter(Boolean);


  /*
    Remove exact duplicate image URLs.
  */
  const uniqueImages = [
    ...new Set(images)
  ];


  /*
    Fallback if detailed item lookup
    doesn't return images.
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


/*
  MAIN API HANDLER
*/
module.exports =
async function handler(req, res) {

  cors(res);


  /*
    CORS PREFLIGHT
  */
  if (req.method === "OPTIONS") {
    return res
      .status(204)
      .end();
  }


  /*
    STOCK API IS READ-ONLY
  */
  if (req.method !== "GET") {
    return res
      .status(405)
      .json({
        success: false,
        error: "Use GET."
      });
  }


  try {

    /*
      -----------------------------------
      STEP 1
      Get eBay API access token
      -----------------------------------
    */

    const accessToken =
      await getToken();


    /*
      -----------------------------------
      STEP 2
      Get hidden DRIFTiT listing IDs
      from Redis
      -----------------------------------
    */

    const hiddenIds =
      await getHiddenStockIds();

    const hiddenSet =
      new Set(
        hiddenIds.map(String)
      );


    /*
      -----------------------------------
      STEP 3
      Find active DRIFTiT eBay listings
      -----------------------------------
    */

    const params =
      new URLSearchParams({

        category_ids:
          "6030",

        filter:
          `sellers:{${SELLER}}`,

        sort:
          "newlyListed",

        limit:
          "12"

      });


    const response =
      await fetch(
        `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`,
        {
          method: "GET",

          headers:
            ebayHeaders(
              accessToken,
              "STOCK"
            )
        }
      );


    const data =
      await response
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
      -----------------------------------
      STEP 4
      Prepare active inventory
      -----------------------------------

      We remove:

      1. Invalid listings
      2. Sandbox/test listing
      3. Listings hidden from DRIFTiT
    */

    const summaries = (
      data.itemSummaries || []
    )

      .map(item => ({
        item,
        legacyId:
          getLegacyId(item)
      }))


      /*
        Must have a valid eBay item ID
      */
      .filter(
        x =>
          x.legacyId
      )


      /*
        Remove sandbox/test listing
      */
      .filter(
        x =>
          x.legacyId !==
          "110590958349"
      )


      /*
        Remove listings that YOU have
        hidden from DRIFTiT.

        They remain active on eBay.
      */
      .filter(
        x =>
          !hiddenSet.has(
            String(x.legacyId)
          )
      );


    /*
      -----------------------------------
      STEP 5
      Retrieve complete listing data
      -----------------------------------

      This preserves the working
      multiple-photo/full-resolution system.
    */

    const detailedItems =
      await Promise.all(

        summaries.map(
          async entry => {

            const fullItem =
              await getFullItem(
                accessToken,
                entry.legacyId
              );

            return {
              summary:
                entry.item,

              full:
                fullItem,

              legacyId:
                entry.legacyId
            };

          }
        )
      );


    /*
      -----------------------------------
      STEP 6
      Build DRIFTiT inventory response
      -----------------------------------
    */

    const items =
      detailedItems.map(
        ({
          summary,
          full,
          legacyId
        }) => {

          const source =
            full || summary;


          /*
            Full-resolution gallery
          */
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


            price:
              source.price

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
              Full-size main image
            */
            image:
              images[0] || "",


            /*
              Full-size eBay gallery
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
              Useful for testing gallery
            */
            imageCount:
              images.length,


            environment:
              "production"

          };

        }
      );


    /*
      -----------------------------------
      STEP 7
      Return inventory to website
      -----------------------------------
    */

    return res
      .status(200)
      .json({

        success:
          true,

        seller:
          SELLER,

        count:
          items.length,

        /*
          Useful for confirming the hide
          system is working.
        */
        hiddenCount:
          hiddenIds.length,

        items

      });


  } catch (error) {

    console.error(
      "DRIFTiT automatic stock error:",
      error
    );


    return res
      .status(502)
      .json({

        success:
          false,

        seller:
          SELLER,

        error:
          error?.message ||
          "Unable to load DRIFTiT stock."

      });
  }
};
