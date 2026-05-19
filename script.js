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

if (yearEl) {
  yearEl.textContent = new Date().getFullYear();
}

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
