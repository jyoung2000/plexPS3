'use strict';
// src/ecmascript/es_misc.c: message(message, ok, cancel) -> boolean,
// textDialog(message, ok, cancel) -> {input, rejected} | {rejected:true}
exports.create = function(world) {
  return {
    notify(text, delay, icon) { world.notifications.push(String(text)); },
    message(text, ok, cancel) { world.messages.push(String(text)); return typeof world.messageAnswer === 'function' ? world.messageAnswer(text) : !!world.messageAnswer; },
    textDialog(text, ok, cancel) {
      world.messages.push(String(text));
      if(world.textAnswer === null || world.textAnswer === undefined) return { rejected: true };
      return { input: String(world.textAnswer), rejected: false };
    },
    webpopup() { return { result: 'userclose' }; },
    getAuthCredentials() { return { rejected: true }; }
  };
};
