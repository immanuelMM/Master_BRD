function requireAdmin(user) {
  if (!user || user.role !== 'Admin') throw new Error('Forbidden: Admin role required');
}

async function exportMonthlySalesCsv(db, user, year, month) {
  requireAdmin(user);
  const rows = await db.orders.salesByMonth(year, month);
  const header = 'date,orders,revenue';
  return [header, ...rows.map((r) => `${r.date},${r.orders},${r.revenue}`)].join('\n');
}

module.exports = { exportMonthlySalesCsv, requireAdmin };
