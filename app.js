const root = document.documentElement;
const sessionStatus = document.querySelector('#sessionStatus');
const listeningStatus = document.querySelector('#listeningStatus');
const errorStatus = document.querySelector('#errorStatus');
const toggleListening = document.querySelector('#toggleListening');
const addCaption = document.querySelector('#addCaption');
const showNotice = document.querySelector('#showNotice');
const dismissNotice = document.querySelector('#dismissNotice');
const notice = document.querySelector('.notice');
const captionList = document.querySelector('#captionList');

let listening = false;
let captionCount = 2;

function setSessionMessage(message) {
  sessionStatus.textContent = message;
}

document.querySelectorAll('input[name="captionSize"]').forEach((input) => {
  input.addEventListener('change', () => {
    root.dataset.captionSize = input.value;
    setSessionMessage(`Caption size set to ${input.parentElement.textContent.trim()}.`);
  });
});

document.querySelectorAll('input[name="theme"]').forEach((input) => {
  input.addEventListener('change', () => {
    root.dataset.theme = input.value;
    setSessionMessage(`${input.parentElement.textContent.trim()} theme selected.`);
  });
});

toggleListening.addEventListener('click', () => {
  listening = !listening;
  toggleListening.setAttribute('aria-pressed', String(listening));
  toggleListening.textContent = listening ? 'Stop listening' : 'Start listening';
  toggleListening.setAttribute('aria-label', toggleListening.textContent);
  listeningStatus.textContent = listening ? 'Listening is on.' : 'Listening is off.';
  setSessionMessage(listening ? 'Listening' : 'Session paused');
});

addCaption.addEventListener('click', () => {
  captionCount += 1;
  const speaker = captionCount % 2 === 0 ? 'Guest' : 'Host';
  const item = document.createElement('li');
  item.className = 'caption-card';
  item.dataset.speaker = speaker;
  item.innerHTML = `
    <span class="speaker-marker" aria-hidden="true">${speaker} marker</span>
    <div>
      <p class="speaker-label">Speaker: ${speaker}</p>
      <p class="caption-text">Sample caption ${captionCount}. This update is announced in the session status.</p>
    </div>
  `;
  captionList.append(item);
  setSessionMessage(`Caption ${captionCount} added for speaker ${speaker}.`);
});

showNotice.addEventListener('click', () => {
  notice.hidden = false;
  errorStatus.textContent = 'Important notice shown.';
  dismissNotice.focus();
});

dismissNotice.addEventListener('click', () => {
  notice.hidden = true;
  showNotice.focus();
  setSessionMessage('Notice closed.');
});

root.dataset.captionSize = 'large';
root.dataset.theme = 'standard';
