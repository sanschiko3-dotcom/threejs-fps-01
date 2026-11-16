// Input: pointer lock, the live set of held keys, and hold-to-fire.
// Look deltas accumulate here and are consumed once per frame by main.js,
// so a fast flick never loses movement between frames.
export function createInput(canvas, onLockChange) {
  const state = {
    keys: new Set(),
    firing: false,
  };
  let lookX = 0;
  let lookY = 0;

  // Browsers fire a mousemove with a large jump when pointer lock engages
  // (the cursor snaps to the lock point); counting it would spin the view
  // on a real click-to-play. The jump is dropped here, and the detection
  // deliberately does NOT rely on the pointerlockchange event: measured in
  // this browser, the jump mousemove can be dispatched BEFORE the
  // lockchange event reaches the page, so any guard keyed on lockchange
  // arrives too late. Instead the handler watches the lock state itself:
  // the first mousemove observed while locked is the snap, and it is
  // dropped. A single huge move shortly after a lock is also dropped as a
  // backstop, in case the snap arrives as a later event. A genuine flick
  // right after locking loses at most one look event, which nobody can feel.
  let seenLockedMove = false;
  let lockedSince = 0;

  function isLocked() {
    return document.pointerLockElement === canvas;
  }

  document.addEventListener('pointerlockchange', () => {
    onLockChange(isLocked());
  });

  document.addEventListener('mousemove', (event) => {
    if (!isLocked()) {
      seenLockedMove = false;
      return;
    }
    const mx = event.movementX || 0;
    const my = event.movementY || 0;
    if (!seenLockedMove) {
      seenLockedMove = true;
      lockedSince = performance.now();
      return;
    }
    const freshLock = performance.now() - lockedSince < 2000;
    const huge = Math.abs(mx) > 120 || Math.abs(my) > 120;
    if (freshLock && huge) return;
    lookX += mx;
    lookY += my;
  });

  document.addEventListener('mousedown', (event) => {
    if (isLocked() && event.button === 0) state.firing = true;
  });
  document.addEventListener('mouseup', (event) => {
    if (event.button === 0) state.firing = false;
  });

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') event.preventDefault();
    state.keys.add(event.code);
  });
  window.addEventListener('keyup', (event) => {
    state.keys.delete(event.code);
  });
  window.addEventListener('blur', () => {
    state.keys.clear();
    state.firing = false;
  });

  return {
    state,

    requestLock() {
      canvas.requestPointerLock();
    },

    get locked() {
      return isLocked();
    },

    takeLook() {
      const look = { x: lookX, y: lookY };
      lookX = 0;
      lookY = 0;
      return look;
    },
  };
}
