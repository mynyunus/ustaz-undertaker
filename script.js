const mobileToggle = document.querySelector('.mobile-toggle');
const siteNav = document.querySelector('#site-nav');
const navLinks = document.querySelectorAll('.site-nav a');
const faqButtons = document.querySelectorAll('.faq-question');
const revealEls = document.querySelectorAll('.reveal');
const stickyCta = document.querySelector('#sticky-cta');
const ctaSection = document.querySelector('#cta');
const floatingWa = document.querySelector('.floating-wa');
const heroSection = document.querySelector('#hero');
const yearEl = document.querySelector('#year');
const articleGrid = document.querySelector('#article-grid');
const articleStatus = document.querySelector('#article-status');
const articleDetail = document.querySelector('#article-detail');
const articleDetailTitle = document.querySelector('#article-detail-title');
const articleDetailMeta = document.querySelector('#article-detail-meta');
const articleDetailBody = document.querySelector('#article-detail-body');
const articleOpenDoc = document.querySelector('#article-open-doc');

if (yearEl) {
  yearEl.textContent = new Date().getFullYear();
}

initArticleSection();

if (mobileToggle && siteNav) {
  mobileToggle.addEventListener('click', () => {
    const isOpen = siteNav.classList.toggle('is-open');
    mobileToggle.setAttribute('aria-expanded', String(isOpen));
  });

  navLinks.forEach((link) => {
    link.addEventListener('click', () => {
      siteNav.classList.remove('is-open');
      mobileToggle.setAttribute('aria-expanded', 'false');
    });
  });
}

// Smooth scroll for internal anchors while preserving expected browser behavior.
document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener('click', (event) => {
    const href = anchor.getAttribute('href');
    if (!href || href === '#') return;

    const target = document.querySelector(href);
    if (!target) return;

    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

faqButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    const answer = button.parentElement?.nextElementSibling;

    faqButtons.forEach((otherBtn) => {
      if (otherBtn !== button) {
        otherBtn.setAttribute('aria-expanded', 'false');
        const otherAnswer = otherBtn.parentElement?.nextElementSibling;
        if (otherAnswer) otherAnswer.hidden = true;
      }
    });

    button.setAttribute('aria-expanded', String(!expanded));
    if (answer) answer.hidden = expanded;
  });

  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      button.click();
    }
  });
});

const revealObserver = new IntersectionObserver(
  (entries, observer) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  },
  {
    threshold: 0.1,
    rootMargin: '0px 0px -40px 0px'
  }
);

revealEls.forEach((el) => revealObserver.observe(el));

if (stickyCta && ctaSection) {
  const ctaObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          stickyCta.classList.add('is-hidden');
        } else {
          stickyCta.classList.remove('is-hidden');
        }
      });
    },
    { threshold: 0.25 }
  );

  ctaObserver.observe(ctaSection);
}

if (floatingWa && heroSection) {
  const mobileMedia = window.matchMedia('(max-width: 719px)');
  let heroObserver;

  const mountFloatingWaObserver = () => {
    if (heroObserver) {
      heroObserver.disconnect();
      heroObserver = null;
    }

    if (!mobileMedia.matches) {
      floatingWa.classList.add('is-visible');
      return;
    }

    floatingWa.classList.remove('is-visible');
    heroObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            floatingWa.classList.remove('is-visible');
          } else {
            floatingWa.classList.add('is-visible');
          }
        });
      },
      {
        threshold: 0.15
      }
    );

    heroObserver.observe(heroSection);
  };

  mountFloatingWaObserver();

  if (typeof mobileMedia.addEventListener === 'function') {
    mobileMedia.addEventListener('change', mountFloatingWaObserver);
  } else {
    mobileMedia.addListener(mountFloatingWaObserver);
  }
}

async function initArticleSection() {
  if (!articleGrid || !articleStatus || !articleDetail) return;

  articleStatus.textContent = 'Memuatkan artikel terkini...';
  articleStatus.classList.remove('is-error');
  articleStatus.hidden = false;
  articleGrid.hidden = true;
  articleDetail.hidden = true;

  try {
    const payload = await fetchArticlesPayload();
    const articles = Array.isArray(payload.articles) ? payload.articles : [];

    if (articles.length === 0) {
      articleStatus.textContent = 'Artikel belum tersedia. Sila semak semula sebentar lagi.';
      return;
    }

    renderArticleCards(articles);
    showArticleDetail(articles[0], payload.sourceDocId);

    articleStatus.hidden = true;
    articleGrid.hidden = false;
    articleDetail.hidden = false;
  } catch (error) {
    console.error('article_section_error', error);
    if (error?.code === 'LOCAL_MISSING_API') {
      articleStatus.textContent =
        'Artikel sedang dikemaskini dan belum dapat dipaparkan buat masa ini. Sila cuba semula sebentar lagi.';
    } else {
      articleStatus.textContent = 'Artikel tidak dapat dimuatkan buat masa ini. Sila cuba semula sebentar lagi.';
    }
    articleStatus.classList.add('is-error');
  }
}

async function fetchArticlesPayload() {
  const candidates = getArticleApiCandidates();
  let lastError = null;
  const failures = [];

  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} @ ${url}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      failures.push(error?.message || String(error));
    }
  }

  const isLocalHost = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
  if (isLocalHost) {
    const localError = new Error(
      `${lastError?.message || 'Local API missing'} | attempts: ${failures.join(' || ')}`
    );
    localError.code = 'LOCAL_MISSING_API';
    throw localError;
  }

  throw lastError || new Error(`Unable to fetch articles | attempts: ${failures.join(' || ')}`);
}

function getArticleApiCandidates() {
  const origin = window.location.origin;
  const isLocalHost = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
  const urls = ['/api/articles', `${origin}/api/articles`];

  if (isLocalHost) {
    urls.push(
      'http://127.0.0.1:8787/api/articles',
      'http://localhost:8787/api/articles',
      'https://ustazundertaker.com/api/articles'
    );
  }

  // Remove duplicates while preserving order.
  return [...new Set(urls)];
}

function renderArticleCards(articles) {
  if (!articleGrid) return;
  articleGrid.innerHTML = '';

  articles.forEach((article, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'article-card';
    button.dataset.tabId = article.tabId || '';

    const title = escapeHtml(article.title || `Artikel ${index + 1}`);
    const excerpt = escapeHtml(article.excerpt || 'Artikel ini sedang dikemaskini.');
    const wordCount = Number.isFinite(article.wordCount) ? article.wordCount : 0;

    button.innerHTML = `\n      <span class=\"article-card-order\">Artikel ${index + 1}</span>\n      <h3>${title}</h3>\n      <p>${excerpt}</p>\n      <span class=\"article-card-meta\">${wordCount} patah perkataan</span>\n    `;

    button.addEventListener('click', () => {
      showArticleDetail(article);
      highlightActiveArticle(article.tabId || '', button);
    });

    articleGrid.appendChild(button);
  });

  const firstCard = articleGrid.querySelector('.article-card');
  if (firstCard) {
    firstCard.classList.add('is-active');
  }
}

function showArticleDetail(article, sourceDocId = null) {
  if (!articleDetailTitle || !articleDetailMeta || !articleDetailBody || !articleOpenDoc) return;

  articleDetailTitle.textContent = article.title || 'Artikel';
  articleDetailMeta.textContent = `${article.wordCount || 0} patah perkataan`;
  articleDetailBody.innerHTML = article.contentHtml || '<p>Artikel ini sedang dikemaskini.</p>';

  const fallbackDocId = sourceDocId || '1gK5AdhT7wEc_M8dYzRBTcjbNtA0FrYCDvjqCdn_bGgM';
  const tab = article.tabId ? encodeURIComponent(article.tabId) : 't.0';
  articleOpenDoc.href = article.sourceUrl || `https://docs.google.com/document/d/${fallbackDocId}/edit?tab=${tab}`;
}

function highlightActiveArticle(tabId, activeButton) {
  if (!articleGrid) return;

  articleGrid.querySelectorAll('.article-card').forEach((card) => {
    card.classList.remove('is-active');
    if (card === activeButton || card.dataset.tabId === tabId) {
      card.classList.add('is-active');
    }
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
