import React from 'react';

export const metadata = {
  title: 'Dashboard — Analytics Overview',
  description: 'View real-time analytics, user metrics, and system health.',
};

interface MetricCard {
  label: string;
  value: number;
  change: number;
  unit?: string;
}

async function fetchMetrics(): Promise<MetricCard[]> {
  // In a real app this would be a fetch() call to an API
  return [
    { label: 'Active Users', value: 12847, change: 5.2, unit: 'users' },
    { label: 'Revenue', value: 48230, change: -2.1, unit: 'USD' },
    { label: 'Conversion Rate', value: 3.8, change: 0.4, unit: '%' },
    { label: 'Avg Response Time', value: 142, change: -12, unit: 'ms' },
  ];
}

function formatChange(change: number): string {
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(1)}%`;
}

export default async function Page() {
  const metrics = await fetchMetrics();

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <h1>Analytics Overview</h1>
        <p className="subtitle">Real-time metrics for the last 30 days</p>
      </header>

      <section className="metrics-grid" aria-label="Key metrics">
        {metrics.map((metric) => (
          <div key={metric.label} className="metric-card">
            <span className="metric-label">{metric.label}</span>
            <span className="metric-value">
              {metric.value.toLocaleString()}
              {metric.unit && <span className="metric-unit"> {metric.unit}</span>}
            </span>
            <span
              className={`metric-change ${metric.change >= 0 ? 'positive' : 'negative'}`}
            >
              {formatChange(metric.change)}
            </span>
          </div>
        ))}
      </section>

      <section className="dashboard-content">
        <div className="chart-placeholder">
          <h2>Traffic Over Time</h2>
          <p>Chart component would render here with real data.</p>
        </div>
        <div className="recent-activity">
          <h2>Recent Activity</h2>
          <ul>
            <li>User sign-ups increased 12% this week</li>
            <li>API latency dropped below 150ms threshold</li>
            <li>New deployment completed at 14:32 UTC</li>
          </ul>
        </div>
      </section>
    </main>
  );
}
