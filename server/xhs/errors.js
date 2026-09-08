const IP_BLOCK_CODE = 300012;
const SECURITY_LIMIT_CODE = 300011;
const NOTE_NOT_FOUND_CODE = -510000;
const NOTE_ABNORMAL_CODE = -510001;

class XhsSessionError extends Error {
  constructor(message, code = 'fetch') {
    super(message);
    this.name = 'XhsSessionError';
    this.code = code;
  }
}

function isXhsAuthError(error) {
  if (!(error instanceof XhsSessionError)) {
    return /300011|signed session|missing the a1|missing the web_session|cookie is empty/i.test(String(error?.message || error || ''));
  }
  return error.code === 'auth';
}

function isXhsVerificationError(error) {
  if (error instanceof XhsSessionError && error.code === 'verification') return true;
  return /461|471|verification/i.test(String(error?.message || error || ''));
}

function isXhsNotFoundError(error) {
  if (error instanceof XhsSessionError && error.code === 'not_found') return true;
  return /-510000|-510001|note not found|note status abnormal/i.test(String(error?.message || error || ''));
}

function headerValue(response, name) {
  if (!response?.headers?.get) return '';
  return String(response.headers.get(name) || response.headers.get(name.toLowerCase()) || '').trim();
}

function throwForHttpStatus(response) {
  const status = Number(response?.status);
  if (status === 461 || status === 471) {
    const verifyType = headerValue(response, 'Verifytype');
    const verifyUuid = headerValue(response, 'Verifyuuid');
    const extra = verifyType ? ` Verifytype=${verifyType} Verifyuuid=${verifyUuid}` : '';
    throw new XhsSessionError(`Xiaohongshu requested verification (${status})${extra}`, 'verification');
  }
  if (status === 429) {
    throw new XhsSessionError('Xiaohongshu returned 429', 'rate');
  }
  if (status === 401 || status === 403) {
    throw new XhsSessionError(`Xiaohongshu returned ${status}`, 'auth');
  }
  if (!response?.ok) throw new XhsSessionError(`Xiaohongshu returned ${status}`, 'fetch');
}

function assertSessionResponse(data) {
  const code = Number(data?.code);
  const msg = String(data?.msg || '');
  if (code === IP_BLOCK_CODE) {
    throw new XhsSessionError(`Xiaohongshu blocked this IP (code=${IP_BLOCK_CODE}): ${msg || 'network connection error'}`, 'rate');
  }
  if (code === NOTE_NOT_FOUND_CODE || code === NOTE_ABNORMAL_CODE) {
    throw new XhsSessionError(`Xiaohongshu note not found or abnormal (code=${code})`, 'not_found');
  }
  if (code === SECURITY_LIMIT_CODE) {
    throw new XhsSessionError(`Xiaohongshu rejected the signed session (code=${code}): ${msg || 'account risk control'}`, 'auth');
  }
  if (data?.success === false) {
    if (/异常/.test(msg) && code !== IP_BLOCK_CODE && code !== NOTE_NOT_FOUND_CODE && code !== NOTE_ABNORMAL_CODE) {
      throw new XhsSessionError(`Xiaohongshu rejected the signed session (code=${code || 'unknown'}): ${msg || 'account risk control'}`, 'auth');
    }
    throw new XhsSessionError(msg || `Xiaohongshu returned code ${code || 'unknown'}`, 'fetch');
  }
  return data;
}

module.exports = {
  IP_BLOCK_CODE,
  SECURITY_LIMIT_CODE,
  NOTE_NOT_FOUND_CODE,
  NOTE_ABNORMAL_CODE,
  XhsSessionError,
  isXhsAuthError,
  isXhsVerificationError,
  isXhsNotFoundError,
  headerValue,
  throwForHttpStatus,
  assertSessionResponse,
};
