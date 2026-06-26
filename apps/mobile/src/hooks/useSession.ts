import { createContext, useContext } from 'react';
import { UserSession } from '../auth/permissions';

export interface SessionContextValue {
  user: UserSession | null;
  setUser: (user: UserSession | null) => void;
  logout: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue>({
  user: null,
  setUser: () => {},
  logout: async () => {},
});

export function useSession(): SessionContextValue {
  return useContext(SessionContext);
}
