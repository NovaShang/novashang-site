// Sends the secondary domains (shanggao.me, www.*) to novashang.com, keeping
// the path and query. Temporary (302) while we check nothing breaks; switch
// STATUS to 301 once it has run cleanly for a few days.
const TARGET = 'https://novashang.com';
const STATUS = 302;

export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.redirect(TARGET + url.pathname + url.search, STATUS);
  },
};
