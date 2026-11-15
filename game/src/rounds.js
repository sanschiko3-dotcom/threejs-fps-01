// Rounds: the match state machine, the economy and the device.
// First to 8 rounds takes the match (max 15; a 7-7 after 15 is a draw).
// Buy phase 12 s, live round 100 s, 4 s between rounds. The device fuses
// 40 s after planting. Economy is Counter-Strike shaped: $800 to start,
// $300 a kill, $3250 a round win, $1900 a loss plus $500 per consecutive loss.
import { MAP } from './map.js';

const WIN_ROUNDS = 8;
const MAX_ROUNDS = 15;
const FUSE_TIME = 40;
const INTERMISSION = 4;
const KILL_REWARD = 300;
const WIN_REWARD = 3250;
const LOSS_REWARD = 1900;
const LOSS_STREAK_BONUS = 500;

export function createRounds(hooks) {
  const state = {
    phase: 'buy', // 'buy' | 'live' | 'over' | 'matchEnd'
    round: 1,
    score: { attack: 0, defend: 0 },
    money: 800,
    lossStreak: 0,
    timer: MAP.buyTime,
    bomb: {
      state: 'carried', // 'carried' | 'dropped' | 'planted' | 'none'
      site: null,
      pos: null,
      plantedAt: 0,
    },
    lastWinner: null,
    lastReason: '',
  };

  function endRound(winner, reason) {
    if (state.phase !== 'live') return;
    state.score[winner] += 1;
    state.lastWinner = winner;
    state.lastReason = reason;
    if (winner === 'attack') {
      state.money += WIN_REWARD;
      state.lossStreak = 0;
    } else {
      state.money += LOSS_REWARD + LOSS_STREAK_BONUS * Math.min(2, state.lossStreak);
      state.lossStreak += 1;
    }
    state.phase = 'over';
    state.timer = INTERMISSION;
    hooks.onRoundEnd(winner, reason, { ...state.score });
  }

  function startRound() {
    state.phase = 'buy';
    state.timer = MAP.buyTime;
    state.bomb = { state: 'carried', site: null, pos: null, plantedAt: 0 };
    hooks.onRoundStart(state.round);
  }

  function finishMatch() {
    state.phase = 'matchEnd';
    const winner = state.score.attack > state.score.defend
      ? 'attack'
      : state.score.defend > state.score.attack ? 'defend' : 'draw';
    hooks.onMatchEnd(winner, { ...state.score });
  }

  return {
    state,

    startMatch() {
      state.round = 1;
      state.score = { attack: 0, defend: 0 };
      state.money = 800;
      state.lossStreak = 0;
      startRound();
    },

    step(dt, now, alive) {
      if (state.phase === 'matchEnd') return;
      state.timer -= dt;
      if (state.phase === 'buy') {
        if (state.timer <= 0) {
          state.phase = 'live';
          state.timer = MAP.roundTime;
          hooks.onLiveStart(state.round);
        }
        return;
      }
      if (state.phase === 'over') {
        if (state.timer <= 0) {
          if (state.score.attack >= WIN_ROUNDS || state.score.defend >= WIN_ROUNDS || state.round >= MAX_ROUNDS) {
            finishMatch();
          } else {
            state.round += 1;
            startRound();
          }
        }
        return;
      }
      // Live round.
      if (state.bomb.state === 'planted') {
        if (now - state.bomb.plantedAt >= FUSE_TIME) {
          hooks.onBombExploded(state.bomb.site);
          endRound('attack', 'detonation');
        }
        return;
      }
      if (alive.attack <= 0) endRound('defend', 'elimination');
      else if (alive.defend <= 0) endRound('attack', 'elimination');
      else if (state.timer <= 0) endRound('defend', 'time');
    },

    plant(site, now) {
      if (state.phase !== 'live' || state.bomb.state === 'planted') return false;
      state.bomb = { state: 'planted', site, pos: null, plantedAt: now };
      hooks.onBombPlanted(site);
      return true;
    },

    defuse() {
      if (state.bomb.state !== 'planted') return false;
      state.bomb = { state: 'none', site: null, pos: null, plantedAt: 0 };
      hooks.onBombDefused();
      endRound('defend', 'defuse');
      return true;
    },

    dropBomb(pos) {
      if (state.bomb.state === 'planted') return;
      state.bomb = { state: 'dropped', site: null, pos: { x: pos.x, z: pos.z }, plantedAt: 0 };
    },

    pickupBomb() {
      if (state.bomb.state !== 'dropped') return false;
      state.bomb = { state: 'carried', site: null, pos: null, plantedAt: 0 };
      return true;
    },

    bombTimeLeft(now) {
      if (state.bomb.state !== 'planted') return 0;
      return Math.max(0, FUSE_TIME - (now - state.bomb.plantedAt));
    },

    addKillReward() {
      state.money += KILL_REWARD;
    },

    spend(amount) {
      if (state.money < amount) return false;
      state.money -= amount;
      return true;
    },

    // Force a round end from outside the timer (used by the shot staging).
    forceEnd(winner, reason) {
      endRound(winner, reason);
    },
  };
}
