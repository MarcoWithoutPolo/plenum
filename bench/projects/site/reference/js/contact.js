import { validateContact } from '../src/validate.js';
import './common.js';

const form = document.querySelector('#contact-form');
const success = document.querySelector('[data-form-success]');
const successText = success.querySelector('p');
const names = ['name', 'email', 'message'];
const field = (n) => form.elements.namedItem(n);
let submitted = false;

if (new URLSearchParams(location.search).get('topic') === 'order')
  field('message').value = 'Hi! I’d like to order the coffees in my cart. ';

function values() {
  return Object.fromEntries(names.map((n) => [n, field(n).value]));
}

function show(errors, only) {
  for (const n of only ?? names) {
    const input = field(n);
    const error = document.getElementById(`${n}-error`);
    error.textContent = errors[n] ?? '';
    if (errors[n]) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

// After the first attempt, fix messages as the visitor types.
form.addEventListener('input', (e) => {
  if (submitted && names.includes(e.target.name)) show(validateContact(values()), [e.target.name]);
});
form.addEventListener('focusout', (e) => {
  if (submitted && names.includes(e.target.name)) show(validateContact(values()), [e.target.name]);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  submitted = true;
  const errors = validateContact(values());
  show(errors);
  const first = names.find((n) => errors[n]);
  if (first) {
    success.hidden = true;
    field(first).focus();
    return;
  }
  // Nothing is sent anywhere: this is a demo shop.
  const name = field('name').value.trim().split(/\s+/)[0];
  successText.textContent = `Thanks, ${name}! Your message is on its way to the roastery. We usually reply within two working days.`;
  success.hidden = false;
  form.reset();
  submitted = false;
  success.focus();
});
