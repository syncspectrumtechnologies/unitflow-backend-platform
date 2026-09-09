const prisma = require('../config/db');
const httpError = require('../utils/httpError');

const NOTIFICATION_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

function parseLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 100);
}

function parseReadFilter(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'all') return undefined;
  if (['true', '1', 'yes', 'read'].includes(raw)) return true;
  if (['false', '0', 'no', 'unread'].includes(raw)) return false;
  return undefined;
}

function ownerNotificationWhere(accountId) {
  return {
    OR: [
      { account_id: accountId },
      { tenant: { is: { owner_account_id: accountId } } }
    ]
  };
}

function serializeNotification(row) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    tenant_name: row.tenant?.display_name || row.tenant?.legal_name || row.tenant?.slug || null,
    type: row.type,
    title: row.title,
    body: row.body,
    severity: row.severity,
    payload: row.payload_json || null,
    is_read: row.is_read,
    created_at: row.created_at
  };
}

exports.listNotifications = async (req, res, next) => {
  try {
    const isRead = parseReadFilter(req.query.is_read ?? req.query.read);
    const limit = parseLimit(req.query.limit);
    const where = {
      ...ownerNotificationWhere(req.account.id),
      ...(isRead === undefined ? {} : { is_read: isRead })
    };

    const [notifications, unreadCount] = await Promise.all([
      prisma.platformNotification.findMany({
        where,
        include: { tenant: { select: { id: true, display_name: true, legal_name: true, slug: true } } },
        orderBy: { created_at: 'desc' },
        take: limit
      }),
      prisma.platformNotification.count({
        where: {
          ...ownerNotificationWhere(req.account.id),
          is_read: false
        }
      })
    ]);

    res.json({
      ok: true,
      unread_count: unreadCount,
      notifications: notifications.map(serializeNotification)
    });
  } catch (error) { next(error); }
};

exports.markNotificationRead = async (req, res, next) => {
  try {
    const id = String(req.params.notificationId || '').trim();
    if (!NOTIFICATION_ID_PATTERN.test(id)) throw httpError(400, 'notificationId is invalid');

    const existing = await prisma.platformNotification.findFirst({
      where: { id, ...ownerNotificationWhere(req.account.id) }
    });
    if (!existing) throw httpError(404, 'Notification not found');

    const notification = await prisma.platformNotification.update({
      where: { id },
      data: { is_read: true },
      include: { tenant: { select: { id: true, display_name: true, legal_name: true, slug: true } } }
    });

    res.json({ ok: true, notification: serializeNotification(notification) });
  } catch (error) { next(error); }
};

exports.markAllNotificationsRead = async (req, res, next) => {
  try {
    const result = await prisma.platformNotification.updateMany({
      where: {
        ...ownerNotificationWhere(req.account.id),
        is_read: false
      },
      data: { is_read: true }
    });

    res.json({ ok: true, updated_count: result.count });
  } catch (error) { next(error); }
};
