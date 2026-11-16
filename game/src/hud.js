// HUD: every DOM write goes through here so main.js never touches the
// page. Elements live in index.html; this module only updates text,
// widths and visibility. Killfeed entries fade out on their own after
// four seconds; the round banner hides itself after 2.6 seconds.
import { WEAPON_DEFS, GRENADE_PRICE, KEVLAR_PRICE, BUY_ORDER } from './weapons.js';

function el(id) {
  return document.getElementById(id);
}

const BUY_LABELS = {
  dagger: 'Dagger P9',
  stinger: 'Stinger-9 SMG',
  kestrel: 'AR-77 Kestrel',
  longshot: 'Longshot-7 DMR',
  grenade: 'HE grenade',
  kevlar: 'Kevlar vest',
};

const KILLFEED_MAX = 5;
const KILLFEED_FADE_MS = 4000;
const BANNER_HIDE_MS = 2600;

function buyPrice(id) {
  if (id === 'grenade') return GRENADE_PRICE;
  if (id === 'kevlar') return KEVLAR_PRICE;
  return WEAPON_DEFS[id].price;
}

export function createHud() {
  const ammoEl = el('ammo');
  const hitmarkerEl = el('hitmarker');
  const overlayEl = el('overlay');
  const buyMenuEl = el('buy-menu');
  const bannerEl = el('banner');
  const killfeedEl = el('killfeed');
  let hitTimer = 0;
  let bannerTimer = 0;

  // Build the buy menu rows once; showBuy only toggles their state.
  const buyRows = {};
  BUY_ORDER.forEach((id, index) => {
    const row = document.createElement('div');
    row.className = 'buy-row';
    row.innerHTML = `<span class="buy-key">${index + 1}</span>` +
      `<span class="buy-name">${BUY_LABELS[id]}</span>` +
      `<span class="buy-price">$${buyPrice(id)}</span>`;
    buyMenuEl.appendChild(row);
    buyRows[id] = row;
  });

  function setText(id, value) {
    el(id).textContent = value;
  }

  return {
    setHealth(health, armor) {
      setText('health-value', Math.ceil(health));
      setText('armor-value', Math.ceil(armor));
      el('health-bar').style.width = `${Math.max(0, health)}%`;
      el('health').classList.toggle('low', health <= 30);
    },

    setAmmo(mag, reserve, weaponName) {
      setText('ammo-mag', mag);
      setText('ammo-reserve', `/ ${reserve}`);
      setText('weapon-name', weaponName);
      ammoEl.classList.toggle('empty', mag === 0);
    },

    setMoney(money) {
      setText('money-value', `$${money}`);
    },

    setTimer(seconds, phase) {
      const shown = Math.max(0, Math.ceil(seconds));
      setText('timer', `${Math.floor(shown / 60)}:${String(shown % 60).padStart(2, '0')}`);
      el('timer').classList.toggle('urgent', phase === 'live' && shown <= 10);
    },

    setScore(attack, defend, round) {
      setText('score-attack', attack);
      setText('score-defend', defend);
      setText('round-label', `ROUND ${round}`);
    },

    setAlive(attackAlive, defendAlive) {
      setText('alive-attack', `●`.repeat(attackAlive) + `○`.repeat(5 - attackAlive));
      setText('alive-defend', `●`.repeat(defendAlive) + `○`.repeat(5 - defendAlive));
    },

    setBomb(text) {
      const bombEl = el('bomb-status');
      bombEl.textContent = text;
      bombEl.hidden = text === '';
    },

    killfeed(killer, victim, killerTeam, headshot) {
      const entry = document.createElement('div');
      entry.className = 'feed-entry';
      entry.innerHTML = `<span class="${killerTeam}">${killer}</span> ` +
        `<span class="feed-head">${headshot ? '◎' : '▸'}</span> ` +
        `<span>${victim}</span>`;
      killfeedEl.prepend(entry);
      while (killfeedEl.children.length > KILLFEED_MAX) killfeedEl.lastChild.remove();
      window.setTimeout(() => entry.remove(), KILLFEED_FADE_MS);
    },

    hitMarker(kill, holdMs) {
      hitmarkerEl.classList.toggle('kill', kill);
      hitmarkerEl.classList.add('on');
      window.clearTimeout(hitTimer);
      hitTimer = window.setTimeout(() => hitmarkerEl.classList.remove('on'), holdMs);
    },

    showBuy(money, owned) {
      for (const id of BUY_ORDER) {
        const row = buyRows[id];
        row.classList.toggle('owned', owned.includes(id));
        row.classList.toggle('poor', money < buyPrice(id) && !owned.includes(id));
      }
      setText('buy-money', `$${money}`);
      buyMenuEl.hidden = false;
    },

    hideBuy() {
      buyMenuEl.hidden = true;
    },

    showBanner(text, sub) {
      bannerEl.querySelector('.banner-main').textContent = text;
      bannerEl.querySelector('.banner-sub').textContent = sub || '';
      bannerEl.hidden = false;
      window.clearTimeout(bannerTimer);
      bannerTimer = window.setTimeout(() => { bannerEl.hidden = true; }, BANNER_HIDE_MS);
    },

    hideBanner() {
      bannerEl.hidden = true;
    },

    setSpectate(name) {
      const spec = el('spectate');
      spec.textContent = name ? `Spectating ${name} — click to switch` : '';
      spec.hidden = !name;
    },

    showOverlay(kind, score, extra = {}) {
      const title = el('overlay-title');
      const copy = el('overlay-copy');
      const play = el('play');
      if (kind === 'start') {
        title.textContent = 'BLACKWATER DOCK';
        copy.textContent = 'Night shift at the container terminal. Jackals attack: plant the device at crane control (A) or the warehouse (B), or eliminate the Sentinels. First to 8 rounds takes the match.';
        play.textContent = 'Click to play';
      } else if (kind === 'paused') {
        title.textContent = 'PAUSED';
        copy.textContent = 'Click to return to the dock.';
        play.textContent = 'Resume';
      } else if (kind === 'end') {
        title.textContent = extra.winner === 'attack' ? 'JACKALS TAKE THE DOCK' : extra.winner === 'defend' ? 'SENTINELS HOLD THE DOCK' : 'DRAW AT THE DOCK';
        copy.textContent = `Final score — Jackals ${score.attack} : ${score.defend} Sentinels. Click to play again.`;
        play.textContent = 'Play again';
      }
      overlayEl.hidden = false;
    },

    hideOverlay() {
      overlayEl.hidden = true;
    },

    onPlay(callback) {
      el('play').addEventListener('click', callback);
    },
  };
}
