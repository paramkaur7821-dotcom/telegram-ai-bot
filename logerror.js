function logError(label, err) {
  const status = err?.status ?? err?.response?.status ?? null;
  const body = err?.response?.data ?? err?.error ?? null;
  console.error(label, JSON.stringify({
    status,
    message: err?.message ?? String(err),
    body: typeof body === 'string' ? body.slice(0, 500) : body
  }, null, 2));
}

module.exports = logError;
