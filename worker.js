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
    const { html, plain } = parseDocumentTabContent(tab.documentTab, documentJson.lists || {});
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

function parseDocumentTabContent(documentTab, listDefinitions = {}) {
  const structuralElements = documentTab?.body?.content || [];
  const blocks = [];

  for (const element of structuralElements) {
    parseStructuralElement(element, blocks, listDefinitions);
  }

  const normalizedBlocks = normalizeArticleBlocks(blocks);

  return {
    html: renderArticleBlocks(normalizedBlocks),
    plain: normalizedBlocks.map((block) => block.plain).join('\n')
  };
}

function parseStructuralElement(element, blocks, listDefinitions) {
  if (element.paragraph) {
    const parsed = parseParagraph(element.paragraph, listDefinitions);
    const hasPlainText = typeof parsed?.plain === 'string' ? parsed.plain.trim().length > 0 : false;
    if (parsed && (hasPlainText || parsed.type === 'divider')) {
      blocks.push(parsed);
    }
    return;
  }

  if (element.table) {
    for (const row of element.table.tableRows || []) {
      for (const cell of row.tableCells || []) {
        for (const content of cell.content || []) {
          parseStructuralElement(content, blocks, listDefinitions);
        }
      }
    }
    return;
  }

  if (element.tableOfContents) {
    for (const content of element.tableOfContents.content || []) {
      parseStructuralElement(content, blocks, listDefinitions);
    }
  }
}

function parseParagraph(paragraph, listDefinitions = {}) {
  const htmlParts = [];
  const plainParts = [];

  for (const item of paragraph.elements || []) {
    const textRun = item.textRun;
    const autoText = item.autoText;
    const richLink = item.richLink;

    if (textRun?.content) {
      const content = textRun.content;
      const linkUrl = textRun.textStyle?.link?.url;
      htmlParts.push(renderInlineText(content, linkUrl, textRun.textStyle));
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

  const html = sanitizeParagraphHtml(htmlParts.join(''));
  const plain = plainParts.join('').replace(/\n/g, ' ').trim();

  if (!plain) {
    return null;
  }

  const markdownBlock = parseMarkdownBlockFromPlain(plain);
  if (markdownBlock) {
    return markdownBlock;
  }

  const normalizedHtml = applyInlineMarkdownFormatting(html);

  const namedStyleType = paragraph.paragraphStyle?.namedStyleType || '';
  const headingTag = mapHeadingTag(namedStyleType);
  if (headingTag) {
    return {
      type: 'heading',
      tag: headingTag,
      html: normalizedHtml,
      plain
    };
  }

  if (paragraph.paragraphStyle?.headingId) {
    return {
      type: 'heading',
      tag: 'h2',
      html: normalizedHtml,
      plain
    };
  }

  const listId = paragraph.bullet?.listId;
  if (listId) {
    const nestingLevel = Number(paragraph.bullet?.nestingLevel || 0);
    const listType = resolveListType(listDefinitions, listId, nestingLevel);
    return {
      type: 'list_item',
      listId,
      nestingLevel,
      listType,
      html: normalizedHtml,
      plain
    };
  }

  return {
    type: 'paragraph',
    html: normalizedHtml,
    plain
  };
}

function renderInlineText(content, linkUrl = null, textStyle = null) {
  let safeText = escapeHtml(content || '');
  safeText = applyInlineMarkdownFormatting(safeText);

  if (textStyle?.bold) safeText = `<strong>${safeText}</strong>`;
  if (textStyle?.italic) safeText = `<em>${safeText}</em>`;
  if (textStyle?.underline) safeText = `<u>${safeText}</u>`;
  if (textStyle?.strikethrough) safeText = `<s>${safeText}</s>`;

  if (!linkUrl) {
    return safeText;
  }

  const safeUrl = escapeAttribute(linkUrl);
  return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeText}</a>`;
}

function parseMarkdownBlockFromPlain(plainText) {
  const trimmed = normalizeWhitespace(plainText);

  if (!trimmed) {
    return null;
  }

  if (/^-{3,}$/.test(trimmed)) {
    return {
      type: 'divider',
      html: '',
      plain: ''
    };
  }

  const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = Math.min(6, headingMatch[1].length);
    const content = headingMatch[2].trim();
    return {
      type: 'heading',
      tag: `h${level}`,
      html: renderPlainInlineWithMarkdown(content),
      plain: content
    };
  }

  const quoteMatch = trimmed.match(/^>\s+(.+)$/);
  if (quoteMatch) {
    const content = quoteMatch[1].trim();
    return {
      type: 'blockquote',
      html: renderPlainInlineWithMarkdown(content),
      plain: content
    };
  }

  const unorderedMatch = trimmed.match(/^[-*]\s+(.+)$/);
  if (unorderedMatch) {
    const content = unorderedMatch[1].trim();
    return {
      type: 'list_item',
      listId: 'md-ul',
      nestingLevel: 0,
      listType: 'ul',
      html: renderPlainInlineWithMarkdown(content),
      plain: content
    };
  }

  const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
  if (orderedMatch) {
    const content = orderedMatch[1].trim();
    return {
      type: 'list_item',
      listId: 'md-ol',
      nestingLevel: 0,
      listType: 'ol',
      html: renderPlainInlineWithMarkdown(content),
      plain: content
    };
  }

  return null;
}

function renderPlainInlineWithMarkdown(rawText) {
  const links = [];
  const textWithTokens = String(rawText || '').replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => {
      const token = `@@MDLINK${links.length}@@`;
      const safeLabel = escapeHtml(label);
      const safeUrl = escapeAttribute(url);
      links.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`);
      return token;
    }
  );

  let safeText = escapeHtml(textWithTokens);
  safeText = applyInlineMarkdownFormatting(safeText);

  links.forEach((htmlLink, index) => {
    safeText = safeText.replaceAll(`@@MDLINK${index}@@`, htmlLink);
  });

  return safeText;
}

function applyInlineMarkdownFormatting(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function sanitizeParagraphHtml(rawHtml) {
  return String(rawHtml || '')
    .replace(/\n/g, '<br>')
    .replace(/(<br>\s*)+$/g, '')
    .trim();
}

function mapHeadingTag(namedStyleType) {
  switch (namedStyleType) {
    case 'TITLE':
    case 'HEADING_1':
      return 'h2';
    case 'SUBTITLE':
    case 'HEADING_2':
      return 'h3';
    case 'HEADING_3':
      return 'h4';
    case 'HEADING_4':
      return 'h5';
    case 'HEADING_5':
    case 'HEADING_6':
      return 'h6';
    default:
      return null;
  }
}

function resolveListType(listDefinitions, listId, nestingLevel) {
  const defaultType = 'ul';
  const listDef = listDefinitions?.[listId];
  const nestingLevels = listDef?.listProperties?.nestingLevels;

  if (!Array.isArray(nestingLevels) || nestingLevels.length === 0) {
    return defaultType;
  }

  const safeLevel = Math.max(0, Math.min(Number(nestingLevel) || 0, nestingLevels.length - 1));
  const glyphType = nestingLevels[safeLevel]?.glyphType || '';

  return /DECIMAL|DIGIT|ROMAN|ALPHA/i.test(glyphType) ? 'ol' : 'ul';
}

function renderArticleBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return '';
  }

  const htmlParts = [];
  const listStack = [];

  const closeListsToDepth = (targetDepth) => {
    while (listStack.length > targetDepth) {
      const listType = listStack.pop();
      htmlParts.push(`</${listType}>`);
    }
  };

  for (const block of blocks) {
    if (block.type === 'list_item') {
      const targetDepth = 1;
      const listType = block.listType || 'ul';

      closeListsToDepth(targetDepth);

      while (listStack.length < targetDepth) {
        listStack.push(listType);
        htmlParts.push(`<${listType}>`);
      }

      if (listStack[listStack.length - 1] !== listType) {
        closeListsToDepth(Math.max(0, targetDepth - 1));
        listStack.push(listType);
        htmlParts.push(`<${listType}>`);
      }

      htmlParts.push(`<li>${block.html}</li>`);
      continue;
    }

    closeListsToDepth(0);

    if (block.type === 'divider') {
      htmlParts.push('<hr>');
      continue;
    }

    if (block.type === 'blockquote') {
      htmlParts.push(`<blockquote><p>${block.html}</p></blockquote>`);
      continue;
    }

    if (block.type === 'heading' && block.tag) {
      htmlParts.push(`<${block.tag}>${block.html}</${block.tag}>`);
      continue;
    }

    htmlParts.push(`<p>${block.html}</p>`);
  }

  closeListsToDepth(0);
  return htmlParts.join('');
}

function normalizeArticleBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return [];
  }

  const refined = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const current = blocks[index];
    const next = blocks[index + 1] || null;
    const prev = refined[refined.length - 1] || null;

    if (current?.type !== 'paragraph') {
      refined.push(current);
      continue;
    }

    const text = normalizeWhitespace(current.plain || '');
    const words = text.split(' ').filter(Boolean);
    const isShortLine = text.length > 0 && text.length <= 82 && words.length <= 12;
    const endsAsSentence = /[.!?]$/.test(text);

    if (/^\d+\.\s+/.test(text) && text.length <= 120) {
      refined.push({
        ...current,
        type: 'heading',
        tag: 'h3'
      });
      continue;
    }

    if (
      isShortLine &&
      !endsAsSentence &&
      !/[:,]$/.test(text) &&
      /^[A-Za-z0-9(“"'`]/.test(text) &&
      !/^(dan|atau|yang|ia|ini|itu)\b/i.test(text) &&
      (prev?.type === 'divider' || prev === null || prev?.type === 'heading')
    ) {
      refined.push({
        ...current,
        type: 'heading',
        tag: prev === null ? 'h1' : 'h2'
      });
      continue;
    }

    if (shouldInferListItem(text, prev, next)) {
      refined.push({
        ...current,
        type: 'list_item',
        listId: 'inferred-ul',
        nestingLevel: 0,
        listType: 'ul'
      });
      continue;
    }

    refined.push(current);
  }

  return refined;
}

function shouldInferListItem(text, previousBlock, nextBlock) {
  if (!text || !previousBlock) return false;

  const words = text.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 12 || text.length > 86) return false;
  if (/[.!?]$/.test(text)) return false;
  if (/[:,]$/.test(text)) return false;
  if (/^(https?:\/\/|www\.)/i.test(text)) return false;

  const prevText = normalizeWhitespace(previousBlock.plain || '');
  const prevIntroducesList = /(:|ialah|seperti berikut|antaranya)$/i.test(prevText);
  const continuesInferredList =
    previousBlock.type === 'list_item' && previousBlock.listId === 'inferred-ul';

  if (!prevIntroducesList && !continuesInferredList) return false;

  if (nextBlock?.type === 'heading' || nextBlock?.type === 'divider') return false;

  return true;
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
