// Pure validation for the contact form.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_MESSAGE = 10;

/** Field name -> message, for every invalid field. An empty object means the form is valid. */
export function validateContact({ name = '', email = '', message = '' } = {}) {
  const errors = {};
  if (!name.trim()) errors.name = 'Please tell us your name.';
  if (!email.trim()) errors.email = 'Please enter your email address.';
  else if (!EMAIL.test(email.trim()))
    errors.email = 'Please enter a valid email address, like ana@example.com.';
  if (!message.trim()) errors.message = 'Please write a message.';
  else if (message.trim().length < MIN_MESSAGE)
    errors.message = `Your message is a little short: at least ${MIN_MESSAGE} characters, please.`;
  return errors;
}
