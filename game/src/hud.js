// HUD: every DOM write goes through here so main.js never touches the page.
// Elements live in index.html; this module only updates text, widths and
// visibility. Killfeed entries fade out on their own after four seconds.
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

  // Build the buy menu rows once.
  const buyRows = {};
  for (const id of BUY_ORDER) {
    const row = document.createElement('div');
    row.className = 'buy-row';
    row.innerHTML = `<span class="buy-key">${BUY_ORDER.indexOf(id) + 1}</span>` +
      `<span class="buy-name">${BUY_LABELS[id]}</span>` +
      `<span class="buy-price">$${buyPrice(id)}</span>`;
    buyMenuEl.appendChild(row);
    buyRows[id] = row;
  }

  return {
    setHealth(health, armor) {
      el('health-value').textContent = Math.ceil(health);
      el('armor-value').textContent = Math.ceil(armor);
      el('health-bar').style.width = `${Math.max(0, health)}%`;
      el('health').classList.toggle('low', health <= 30);
    },

    setAmmo(mag, reserve, weaponName) {
      el('ammo-mag').textContent = mag;
      el('ammo-reserve').textContent = `/ ${reserve}`;
      el('weapon-name').textContent = weaponName;
      ammoEl.classList.toggle('empty', mag === 0);
    },

    setMoney(money) {
      el('money-value').textContent = `$${money}`;
    },

    setTimer(seconds, phase) {
      const shown = Math.max(0, Math.ceil(seconds));
      el('timer').textContent = `${Math.floor(shown / 60)}:${String(shown % 60).padStart(2, '0')}`;
      el('timer').classList.toggle('urgent', phase === 'live' && shown <= 10);
    },

    setScore(attack, defend, round) {
      el('score-attack').textContent = attack;
      el('score-defend').textContent = defend;
      el('round-label').textContent = `ROUND ${round}`;
    },

    setAlive(attackAlive, defendAlive) {
      el('alive-attack').textContent = `●`.repeat(attackAlive) + `○`.repeat(5 - attackAlive);
      el('alive-defend').textContent = `●`.repeat(defendAlive) + `○`.repeat(5 - defendAlive);
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
      while (killfeedEl.children.length > 5) killfeedEl.lastChild.remove();
      window.setTimeout(() => entry.remove(), 4000);
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
      el('buy-money').textContent = `$${money}`;
      buyMenuEl.hidden = false;
    },

    hideBuy() {
      buyMenuEl.hidden = true;
    },

    showBanner(text, sub) {
      bannerEl.querySelector('.banner-main').textContent = text;
      bannerEl.querySelector('.banner-sub').textContent = sub || '';
      bannerEl.hidden = false;
      window.clearTimeout(bannerEl._timer);
      bannerEl._timer = window.setTimeout(() => { bannerEl.hidden = true; }, 2600);
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
