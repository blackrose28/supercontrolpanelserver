import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeSummarySection } from './RuntimeSummarySection';

describe('RuntimeSummarySection', () => {
  function renderSection(props: typeof baseProps) {
    return render(
      <MemoryRouter>
        <RuntimeSummarySection {...props} />
      </MemoryRouter>,
    );
  }

  afterEach(() => {
    cleanup();
  });

  const baseProps = {
    selectedDeviceId: 'dev-1',
    runtimeSummaryLoading: false,
    runtimeSummaryError: null,
    runtimeSummary: {
      deviceId: 'dev-1',
      updatedAt: '2026-04-20T00:00:00.000Z',
      functions: {
        'vpn-agent': { state: 'running', message: 'healthy' },
        'server-tunnel-srv-1': { state: 'running', message: 'active' },
        'server-tunnel-srv-2': { state: 'idle', message: 'stopped' },
      },
      inventory: {
        servers: [
          { id: 'srv-1', name: 'Boundary Alpha', connectionMethod: 'boundary', host: '127.0.0.1' },
          { id: 'srv-2', name: 'Boundary Beta', connectionMethod: 'boundary', host: '127.0.0.2' },
          { id: 'srv-3', name: 'Direct Gamma', connectionMethod: 'ssh', host: '10.0.0.3' },
        ],
      },
    },
    onRetry: vi.fn(),
  };

  it('renders helper copy, summary cards, and Boundary server runtime links', () => {
    renderSection(baseProps);

    expect(screen.getByText('Track live function health, Boundary tunnels, and the latest device runtime state.')).toBeInTheDocument();
    const highlights = screen.getByLabelText('Runtime summary highlights');
    expect(highlights).toHaveTextContent('Functions reporting');
    expect(highlights).toHaveTextContent('Boundary tunnels');
    expect(highlights).not.toHaveTextContent('Logs loaded');
    expect(highlights).toHaveTextContent('3');
    expect(highlights).toHaveTextContent('2');
    expect(screen.getByText('Boundary tunnel servers')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open runtime for Boundary Alpha' })).toHaveAttribute(
      'href',
      '/admin/devices/dev-1/servers/srv-1/runtime',
    );
    expect(screen.getByRole('link', { name: 'Open runtime for Boundary Beta' })).toHaveAttribute(
      'href',
      '/admin/devices/dev-1/servers/srv-2/runtime',
    );
    expect(screen.queryByText('Direct Gamma')).not.toBeInTheDocument();
  });

  it('moves tunnel controls behind dedicated server runtime links', () => {
    renderSection(baseProps);

    expect(screen.queryByRole('button', { name: 'Stop tunnel for Boundary Alpha' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start tunnel for Boundary Beta' })).not.toBeInTheDocument();
    expect(screen.queryByText('On')).not.toBeInTheDocument();
    expect(screen.queryByText('Off')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open runtime for Boundary Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open runtime for Boundary Beta' })).toBeInTheDocument();
  });

  it('does not render tunnel logs or SSH terminals inline', () => {
    renderSection(baseProps);

    expect(screen.getByRole('link', { name: 'Open runtime for Boundary Alpha' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Tunnel logs')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('SSH terminal for Boundary Alpha')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View logs for Boundary Alpha/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /SSH terminal for Boundary Alpha/i })).not.toBeInTheDocument();
  });
});
