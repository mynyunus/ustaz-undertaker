const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents.readonly';
const CACHE_TTL_SECONDS = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/articles') {
      return handleArticlesApi(request, env, ctx);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleArticlesApi(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }

  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url, request);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCors(cached);
  }

  try {
    validateEnv(env);

    const accessToken = await getGoogleAccessToken(env);
    const docJson = await fetchDocumentTabs(accessToken, env.GOOGLE_DOC_ID);
    const articles = buildArticlesFromDocument(docJson, env.GOOGLE_DOC_ID);

    const payload = {
      updatedAt: new Date().toISOString(),
      sourceDocId: env.GOOGLE_DOC_ID,
      articles
    };

    const response = jsonResponse(payload, 200, {
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    console.error('articles_api_error', error?.message || error);
    return jsonResponse(
      {
        error: 'Tidak dapat memuatkan artikel buat masa ini.',
        details: error?.message || 'Unknown error'
      },
      500
    );
  }
}

function validateEnv(env) {
  const missing = [];

  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) missing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  if (!env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) missing.push('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
  if (!env.GOOGLE_DOC_ID) missing.push('GOOGLE_DOC_ID');

  if (missing.length > 0) {
    throw new Error(`Missing required bindings: ${missing.join(', ')}`);
  }
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const assertionPayload = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: DOCS_SCOPE,
    aud: TOKEN_ENDPOINT,
    exp: now + 3600,
    iat: now
  };

  const assertion = await signJwt(assertionPayload, env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get access token: ${response.status} ${text}`);
  }

  const tokenJson = await response.json();
  if (!tokenJson.access_token) {
    throw new Error('No access_token returned from Google OAuth');
  }

  return tokenJson.access_token;
}

async function signJwt(payload, rawPrivateKey) {
  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const pem = normalizePrivateKey(rawPrivateKey);
  const key = await importPrivateKey(pem);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

function normalizePrivateKey(rawKey) {
  return rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
}

async function importPrivateKey(pem) {
  const cleanPem = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');

  const binaryDer = Uint8Array.from(atob(cleanPem), (char) => char.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function fetchDocumentTabs(accessToken, docId) {
  const response = await fetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}?includeTabsContent=true`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch document tabs: ${response.status} ${text}`);
  }

  return response.json();
}

function buildArticlesFromDocument(documentJson, docId) {
  const flattenedTabs = flattenTabs(documentJson.tabs || []);

  const tabsToRender =
    flattenedTabs.length > 0
      ? flattenedTabs
      : [
          {
            tabId: 't.0',
            title: documentJson.title || 'Artikel',
            documentTab: {
              body: documentJson.body || { content: [] }
            }
          }
        ];

  return tabsToRender.map((tab, index) => {
    const { html, plain } = parseDocumentTabContent(tab.documentTab);
    const cleanText = normalizeWhitespace(plain);

    return {
      id: `article-${index + 1}`,
      tabId: tab.tabId,
      title: normalizeWhitespace(tab.title) || `Artikel ${index + 1}`,
      excerpt: buildExcerpt(cleanText),
      contentHtml: html || '<p>Tiada kandungan buat masa ini.</p>',
      wordCount: countWords(cleanText),
      order: index + 1,
      sourceUrl: `https://docs.google.com/document/d/${docId}/edit?tab=${encodeURIComponent(tab.tabId || 't.0')}`
    };
  });
}

function flattenTabs(tabs) {
  const result = [];
  const seen = new Set();

  const walk = (items) => {
    for (const tab of items || []) {
      const props = tab.tabProperties || tab.properties || {};
      const tabId = props.tabId || props.id || `t.generated-${result.length + 1}`;
      const title = props.title || props.displayName || `Tab ${result.length + 1}`;

      if (!seen.has(tabId)) {
        seen.add(tabId);
        result.push({
          tabId,
          title,
          documentTab: tab.documentTab || null
        });
      }

      const childTabs = Array.isArray(tab.childTabs)
        ? tab.childTabs
        : Array.isArray(tab.documentTab?.childTabs)
          ? tab.documentTab.childTabs
          : [];

      if (childTabs.length > 0) {
        walk(childTabs);
      }
    }
  };

  walk(tabs);
  return result;
}

function parseDocumentTabContent(documentTab) {
  const structuralElements = documentTab?.body?.content || [];
  const htmlParts = [];
  const plainParts = [];

  for (const element of structuralElements) {
    parseStructuralElement(element, htmlParts, plainParts);
  }

  return {
    html: htmlParts.join(''),
    plain: plainParts.join('\n')
  };
}

function parseStructuralElement(element, htmlParts, plainParts) {
  if (element.paragraph) {
    const { html, plain } = parseParagraph(element.paragraph);
    if (plain.trim()) {
      htmlParts.push(`<p>${html}</p>`);
      plainParts.push(plain);
    }
    return;
  }

  if (element.table) {
    for (const row of element.table.tableRows || []) {
      for (const cell of row.tableCells || []) {
        for (const content of cell.content || []) {
          parseStructuralElement(content, htmlParts, plainParts);
        }
      }
    }
    return;
  }

  if (element.tableOfContents) {
    for (const content of element.tableOfContents.content || []) {
      parseStructuralElement(content, htmlParts, plainParts);
    }
  }
}

function parseParagraph(paragraph) {
  const htmlParts = [];
  const plainParts = [];

  for (const item of paragraph.elements || []) {
    const textRun = item.textRun;
    const autoText = item.autoText;
    const richLink = item.richLink;

    if (textRun?.content) {
      const content = textRun.content;
      const linkUrl = textRun.textStyle?.link?.url;
      htmlParts.push(renderInlineText(content, linkUrl));
      plainParts.push(content);
      continue;
    }

    if (autoText?.content) {
      htmlParts.push(renderInlineText(autoText.content));
      plainParts.push(autoText.content);
      continue;
    }

    if (richLink?.richLinkProperties?.title) {
      const label = richLink.richLinkProperties.title;
      const uri = richLink.richLinkProperties.uri;
      htmlParts.push(renderInlineText(label, uri));
      plainParts.push(label);
    }
  }

  const html = htmlParts.join('').replace(/\n/g, '<br>').trim();
  const plain = plainParts.join('').replace(/\n/g, ' ').trim();

  return { html, plain };
}

function renderInlineText(content, linkUrl = null) {
  const safeText = escapeHtml(content || '');

  if (!linkUrl) {
    return safeText;
  }

  const safeUrl = escapeAttribute(linkUrl);
  return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeText}</a>`;
}

function normalizeWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function buildExcerpt(text) {
  if (!text) {
    return 'Artikel ini sedang dikemaskini.';
  }

  if (text.length <= 180) {
    return text;
  }

  return `${text.slice(0, 180).trimEnd()}…`;
}

function countWords(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return 0;
  return normalized.split(' ').filter(Boolean).length;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders();
  Object.entries(cors).forEach(([key, value]) => headers.set(key, value));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extraHeaders
    }
  });
}
