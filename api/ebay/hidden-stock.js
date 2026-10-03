const ALLOWED_ORIGIN = process.env.DRIFTIT_ORIGIN || "*";
const REDIS_KEY = "driftit:hidden-stock";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function redisConfig() {
  const url = process.env.DRIFTIT_REDIS_KV_REST_API_URL;
  const token = process.env.DRIFTIT_REDIS_KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error("Missing DRIFTiT Redis configuration.");
  }

  return {
    url: url.replace(/\/$/, ""),
    token
  };
}

async function redis(command) {
  const { url, token } = redisConfig();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(data.error || "Redis request failed.");
  }

  return data.result;
}

function cleanId(value) {
  return String(value || "").match(/\d{9,15}/)?.[0] || "";
}

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {

    // Get all hidden DRIFTiT listing IDs
    if (req.method === "GET") {
      const ids = (await redis(["SMEMBERS", REDIS_KEY])) || [];

      return res.status(200).json({
        success: true,
        count: ids.length,
        hiddenIds: ids
      });
    }

    // Hide listing from DRIFTiT
    if (req.method === "POST") {
      const legacyId = cleanId(req.body?.legacyId);

      if (!legacyId) {
        return res.status(400).json({
          success: false,
          error: "Valid eBay item ID required."
        });
      }

      await redis(["SADD", REDIS_KEY, legacyId]);

      return res.status(200).json({
        success: true,
        legacyId,
        message: "Listing hidden from DRIFTiT GARAGE."
      });
    }

    // Restore listing to DRIFTiT
    if (req.method === "DELETE") {
      const legacyId = cleanId(req.body?.legacyId);

      if (!legacyId) {
        return res.status(400).json({
          success: false,
          error: "Valid eBay item ID required."
        });
      }

      await redis(["SREM", REDIS_KEY, legacyId]);

      return res.status(200).json({
        success: true,
        legacyId,
        message: "Listing restored to DRIFTiT GARAGE."
      });
    }

    return res.status(405).json({
      success: false,
      error: "Use GET, POST or DELETE."
    });

  } catch (error) {
    console.error("Hidden stock error:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Hidden stock request failed."
    });
  }
};
