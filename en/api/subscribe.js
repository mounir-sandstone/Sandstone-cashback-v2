const KLAVIYO_BASE = "https://a.klaviyo.com/api";

function getJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function klaviyoFetch(path, { method = "GET", apiKey, revision, body } = {}) {
  const res = await fetch(`${KLAVIYO_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      Revision: revision,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { ok: res.ok, status: res.status, json, text };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const apiKey = process.env.KLAVIYO_PRIVATE_API_KEY;
  const listId = process.env.KLAVIYO_LIST_ID;
  const revision = process.env.KLAVIYO_REVISION || "2024-10-15";

  if (!apiKey || !listId) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: "Missing env vars",
        missing: {
          KLAVIYO_PRIVATE_API_KEY: !apiKey,
          KLAVIYO_LIST_ID: !listId,
        },
      })
    );
    return;
  }

  let payload;
  try {
    payload = await getJson(req);
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  const full_name = String(payload.full_name || "").trim();
  const email = String(payload.email || "").trim();
  const budget = String(payload.budget || "").trim();
  const website = String(payload.website || "").trim();

  if (!full_name || !email || !budget || !website) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Missing required fields" }));
    return;
  }

  const parts = full_name.split(/\s+/).filter(Boolean);
  const first_name = parts.shift() || "";
  const last_name = parts.join(" ");

  try {
    // 1) Create profile (of update als email al bestaat)
    const createProfileBody = {
      data: {
        type: "profile",
        attributes: {
          email,
          first_name,
          last_name,
          properties: {
            budget,
            website,
            source: "cashback.sandstone.nl",
          },
        },
      },
    };

    const profileRes = await klaviyoFetch("/profiles/", {
      method: "POST",
      apiKey,
      revision,
      body: createProfileBody,
    });

    // Als profile al bestaat kan Klaviyo een 409 geven. Dan pakken we id via lookup endpoint.
    let profileId = profileRes?.json?.data?.id || null;

    if (!profileId && profileRes.status === 409) {
      const lookup = await klaviyoFetch(`/profiles/?filter=equals(email,"${encodeURIComponent(email)}")`, {
        method: "GET",
        apiKey,
        revision,
      });

      profileId = lookup?.json?.data?.[0]?.id || null;
    }

    if (!profileId) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: "Failed to create or find profile",
          klaviyo_status: profileRes.status,
          klaviyo: profileRes.json || profileRes.text,
        })
      );
      return;
    }

    // 2) Add profile to list
    const addToListBody = {
      data: [{ type: "profile", id: profileId }],
    };

    const addRes = await klaviyoFetch(`/lists/${listId}/relationships/profiles/`, {
      method: "POST",
      apiKey,
      revision,
      body: addToListBody,
    });

    if (!addRes.ok) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: "Failed to add profile to list",
          klaviyo_status: addRes.status,
          klaviyo: addRes.json || addRes.text,
        })
      );
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Server error", detail: String(e?.message || e) }));
  }
};
