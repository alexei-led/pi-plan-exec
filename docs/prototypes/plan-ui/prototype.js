(() => {
  'use strict';
  const scenarios = {
    missing: {
      label: '! Worktree missing', tone: 'warning', accepted: 0,
      phase: 'Task 1 of 12 · needs attention', task: 'Task 1 · execution cannot be verified',
      reason: 'The execution folder was removed. Worker status is unknown.',
      next: 'No replacement worker. Inspect the run, or cancel and keep the record.',
      evidence: 'Reported case: plan read failed with ENOENT.\nMissing files do not prove worker exit.',
    },
    running: {
      label: '● Working', tone: 'success', accepted: 4,
      phase: 'Task 5 of 12 · implementing', task: 'Task 5 · Add the routing decision view',
      reason: '', next: 'Next: verify this task, then accept its commit.',
      evidence: 'Demo: worker tool activity 8s ago.\nController heartbeat is not worker progress.',
    },
    review: {
      label: '◇ Reviewing', tone: 'success', accepted: 12,
      phase: 'Final review · not finished', task: 'Checking the completed implementation',
      reason: '', next: 'Next: resolve findings, run final checks, then archive.',
      evidence: 'Demo: all implementation tasks accepted.\nReview and final verification are still required.',
    },
    retry: {
      label: '↻ Retry scheduled', tone: 'warning', accepted: 4,
      phase: 'Task 5 of 12 · retry in 45s', task: 'Task 5 · Check did not pass',
      reason: 'The previous worker exited. Its partial work is preserved.',
      next: 'Next: retry task 5 in 45s. Pause to prevent another attempt.',
      evidence: 'Demo: predecessor retirement verified; retry authorized.\nCountdown is a fixed fixture, not a live timer.',
    },
    external: {
      label: '! Credentials needed', tone: 'warning', accepted: 4,
      phase: 'Task 5 of 12 · waiting for you', task: 'Task 5 · Repository access unavailable',
      reason: 'The worker reported a failed authentication check.',
      next: 'Sign in to the required service. The controller will check again.',
      evidence: 'Demo prerequisite: credentials.\nEvidence: authentication command returned an authorization failure.',
    },
    unknown: {
      label: '? Worker status unknown', tone: 'warning', accepted: 0,
      phase: 'Task 1 of 12 · checking status', task: 'Task 1 · No verified worker activity',
      reason: 'The controller is reachable; that does not prove the worker is running.',
      next: 'Checking the same operation. No replacement worker will start.',
      evidence: 'Demo: no correlated worker progress or exit proof.\nElapsed time is not a liveness signal.',
    },
    stopping: {
      label: '◌ Stopping', tone: 'warning', accepted: 4,
      phase: 'Stop requested · exit not yet confirmed', task: 'Waiting for the worker to exit',
      reason: 'No new work will be scheduled.',
      next: 'You can hide this view now. The record stays until exit is confirmed.',
      evidence: 'Demo: stop intent persisted. Cancellation receipt is not exit proof.',
    },
    paused: {
      label: 'Ⅱ Paused', tone: 'muted', accepted: 4,
      phase: '4 accepted · 8 remaining', task: 'Your checkpoint is preserved',
      reason: '', next: 'Resume when ready. Nothing restarts automatically.',
      evidence: 'Demo: worker exit verified; explicit user pause.',
    },
    cancelled: {
      label: '× Cancelled', tone: 'muted', accepted: 4,
      phase: 'Stopped · work preserved', task: 'The run has ended',
      reason: '', next: 'Clear this view. Inspect saved work separately if needed.',
      evidence: 'Demo: owned worker exit confirmed. No folder or branch deleted.',
    },
    complete: {
      label: '✓ Complete', tone: 'success', accepted: 12,
      phase: 'Review and checks passed', task: 'All 12 tasks accepted',
      reason: '', next: 'Ready to inspect the result. Clear this view when done.',
      evidence: 'Demo: required review, final checks, and archive completed.',
    },
  };
  const variant = document.body.dataset.variant;
  const scenario = document.querySelector('#scenario');
  const widget = document.querySelector('#widget');
  const footer = document.querySelector('#footer-run');
  const inspector = document.querySelector('#inspector');
  const feedback = document.querySelector('#feedback');
  const command = document.querySelector('#command');
  const key = 'plan-exec-prototype-visibility-' + variant;
  let hidden = false;
  try { hidden = localStorage.getItem(key) === 'hidden'; } catch { /* file URL storage can be disabled */ }
  let state = { ...scenarios.missing };

  function fields(name, value) {
    for (const element of document.querySelectorAll('[data-field="' + name + '"]')) {
      element.textContent = value;
    }
  }
  function render() {
    document.body.style.setProperty('--tone', 'var(--' + state.tone + ')');
    for (const field of ['label', 'phase', 'task', 'reason', 'next']) fields(field, state[field]);
    fields('bar', '█'.repeat(state.accepted) + '░'.repeat(12 - state.accepted));
    fields('count', state.accepted + '/12 tasks accepted');
    fields('footer', state.label + ' · ' + state.accepted + '/12');
    widget.hidden = hidden || variant === 'inspector';
    footer.hidden = hidden;
    for (const reason of document.querySelectorAll('[data-field="reason"]')) reason.hidden = !state.reason;
    const terminal = ['paused', 'cancelled', 'complete', 'stopping'].includes(scenario.value);
    for (const button of document.querySelectorAll('[data-action="pause"]')) button.disabled = terminal;
    for (const button of document.querySelectorAll('[data-action="cancel"]')) {
      button.disabled = ['cancelled', 'complete', 'stopping'].includes(scenario.value);
    }
    const items = [
      state.accepted + ' tasks accepted',
      state.accepted === 12 ? (scenario.value === 'complete' ? 'Review and checks passed' : 'Review and checks in progress') : state.task,
      (12 - state.accepted) + ' tasks not yet accepted',
    ];
    document.querySelector('#task-list').replaceChildren(...items.map(text => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }));
    document.querySelector('#technical').textContent = state.evidence +
      '\n\nFull run ID, owner, branch, paths, lease, provider evidence, and raw errors belong here — not in the persistent widget.\n\nFixture only. Not connected to your run registry.';
  }
  function visibility(value, message) {
    hidden = value;
    try { localStorage.setItem(key, hidden ? 'hidden' : 'shown'); } catch { /* visibility still works for this page */ }
    if (hidden && inspector.open) inspector.close();
    render();
    feedback.textContent = message;
    if (hidden) command.focus();
  }
  function action(name) {
    if (name === 'details') inspector.showModal();
    if (name === 'close') inspector.close();
    if (name === 'hide' || name === 'clear') visibility(true, 'View removed. Run state and recovery evidence unchanged. /exec show restores it.');
    if (name === 'show') visibility(false, 'View restored. No worker started or resumed.');
    if (name === 'pause' || name === 'cancel') {
      if (['cancelled', 'complete', 'stopping'].includes(scenario.value) ||
          (name === 'pause' && scenario.value === 'paused')) {
        feedback.textContent = 'No change: this run is already stopped or stopping.';
        return;
      }
      const accepted = state.accepted;
      const cancelling = name === 'cancel';
      scenario.value = 'stopping';
      state = {
        ...scenarios.stopping, accepted,
        label: cancelling ? '◌ Cancelling' : '◌ Pausing',
        next: cancelling ? 'Waiting for confirmed exit before marking cancelled. Hide is available now.' : 'Waiting for confirmed exit before marking paused. Hide is available now.',
      };
      render();
      feedback.textContent = 'Demo only: ' + name + ' requested, not confirmed. No --apply; no files deleted.';
    }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (button) action(button.dataset.action);
  });
  document.querySelector('#show').addEventListener('click', () => action('show'));
  scenario.addEventListener('change', () => {
    state = { ...scenarios[scenario.value] };
    render();
    feedback.textContent = hidden ? 'Scenario updated; the view stays hidden. /exec show restores it.' : 'Fixture changed. The real run is untouched.';
  });
  document.querySelector('#narrow').addEventListener('change', event => {
    document.querySelector('.terminal').classList.toggle('narrow', event.target.checked);
  });
  document.querySelector('#theme').addEventListener('click', event => {
    const light = document.documentElement.dataset.theme !== 'light';
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    event.target.textContent = light ? 'Dark theme' : 'Light theme';
  });
  document.querySelector('#command-form').addEventListener('submit', event => {
    event.preventDefault();
    const commands = {
      '/exec hide': 'hide', '/exec show': 'show', '/exec clear': 'clear',
      '/exec status': 'details', '/exec pause': 'pause', '/exec cancel': 'cancel',
    };
    const name = commands[command.value.trim()];
    if (name) action(name);
    else feedback.textContent = 'Demo commands: /exec hide · show · clear · status · pause · cancel';
    command.value = '';
  });
  render();
})();
