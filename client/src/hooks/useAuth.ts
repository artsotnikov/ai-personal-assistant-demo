import { useState, useEffect } from "react";

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = () => {
    const token = localStorage.getItem('auth_token');
    const authTime = localStorage.getItem('auth_time');
    
    if (token && authTime) {
      // Check if token is not older than 24 hours
      const tokenAge = Date.now() - parseInt(authTime);
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      
      if (tokenAge < maxAge) {
        setIsAuthenticated(true);
      } else {
        // Token expired, clear it
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_time');
        setIsAuthenticated(false);
      }
    } else {
      setIsAuthenticated(false);
    }
    
    setIsLoading(false);
  };

  const logout = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_time');
    setIsAuthenticated(false);
  };

  const login = (token?: string) => {
    if (token) {
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_time', Date.now().toString());
    }
    setIsAuthenticated(true);
  };

  return {
    isAuthenticated,
    isLoading,
    logout,
    login,
    checkAuth,
  };
}