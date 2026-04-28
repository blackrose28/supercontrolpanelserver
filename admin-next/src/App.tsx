import { AdminDashboardPage } from './pages/AdminDashboardPage';
import { LogoutButton } from './components/LogoutButton';
import './app.css';

export default function App() {
  return (
    <main>
      <h1>Admin Next <LogoutButton /></h1>
      <AdminDashboardPage />
    </main>
  );
}
