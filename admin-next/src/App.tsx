import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AdminDashboardPage } from './pages/AdminDashboardPage';
import { LoginPage } from './pages/LoginPage';
import { ServerRuntimePage } from './pages/ServerRuntimePage';
import './app.css';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin/login" element={<LoginPage />} />
        <Route path="/admin/devices/:deviceId/servers/:serverId/runtime" element={<ServerRuntimePage />} />
        <Route path="/" element={<AdminDashboardPage />} />
        {/* Redirect any /admin related paths to the login page if not handled */}
        <Route path="/admin/*" element={<Navigate to="/admin/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
