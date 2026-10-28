import { randomUUID, createHash } from 'node:crypto';

export function createNotification(kind, body) {
  return { id: randomUUID(), kind, body, emailSent: false, issueSent: false };
}

// Never log response bodies: providers may echo email addresses or credentials.
export async function sendEmail(message, { env = process.env, fetchFn = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const missing = ['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_TO'].filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`缺少 GitHub Secrets：${missing.join(', ')}`);
  const payload = JSON.stringify({
    from: env.EMAIL_FROM.trim(),
    to: env.EMAIL_TO.split(',').map(value => value.trim()).filter(Boolean),
    subject: `虎航票價追蹤｜${message.kind}｜${message.body.split('\n')[0].replace(/^#+\s*/, '')}`,
    text: message.body,
  });
  const key = `tigerair/${message.id}/${createHash('sha256').update(payload).digest('hex')}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchFn('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json', 'Idempotency-Key': key },
        body: payload,
      });
      if (!response.ok) {
        const error = new Error(`Resend HTTP ${response.status}（第 ${attempt}/3 次）`);
        error.permanent = response.status < 500 && response.status !== 429;
        throw error;
      }
      const result = await response.json();
      if (!result.id) throw new Error('Resend 回應缺少 email id');
      return;
    } catch (error) {
      if (error.permanent || attempt === 3) {
        // Network error messages can contain URLs; use a fixed safe description.
        throw new Error(error.message.startsWith('Resend ') ? error.message : 'Resend 網路錯誤或逾時（已重試）');
      }
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

// Each channel has its own acknowledgement. A failed channel never blocks the other.
// The caller persists the queue before sending and after every acknowledgement.
export async function deliverNotifications(queue, { email = sendEmail, emailEnabled = true, issue, save,
  log = console.log, report = console.error, limit = 10 }) {
  const errors = [];
  const emailed = [];
  const issued = [];
  for (const [channel, send] of [['email', email], ['issue', issue]]) {
    if (channel === 'email' && !emailEnabled) continue;
    let count = 0;
    for (const message of queue) {
      if (channel === 'email' && message.emailRequired === false) continue;
      const field = `${channel}Sent`;
      if (message[field]) continue;
      if (count++ >= limit) break;
      try {
        await send(message);
      } catch (error) {
        const detail = `${channel} ${message.id}：${error.message}`;
        errors.push(detail);
        report(`::error title=通知傳送失敗::${detail}`);
        break; // Keep FIFO order and avoid hammering a failing service.
      }
      message[field] = true;
      if (channel === 'email') emailed.push(...message.kind.split('+'));
      if (channel === 'issue') issued.push(...message.kind.split('+'));
      save(); // Persistence errors must be fatal, never mistaken for delivery errors.
      log(`${channel} 已接受通知 ${message.id}`);
    }
  }
  for (let i = queue.length - 1; i >= 0; i--) {
    if ((queue[i].emailSent || queue[i].emailRequired === false) && queue[i].issueSent) queue.splice(i, 1);
  }
  save();
  log(`通知佇列剩餘 ${queue.length} 筆（每管道每次最多 ${limit} 筆）`);
  return { errors, emailed, issued };
}
