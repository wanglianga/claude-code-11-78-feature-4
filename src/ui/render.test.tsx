// ============================================================
// UI 渲染冒烟（Node + renderToString）：验证全部页面组件树
// 可正常渲染、路由与 Provider 装配无误（交互与 IndexedDB
// 行为由 db.test.ts 与手工验证覆盖）。
// ============================================================

import 'fake-indexeddb/auto';
import { describe, expect, it, beforeAll } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../state/auth';
import { AppProvider } from '../state/app';
import { CausalProvider } from '../state/causal';
import LoginPage from '../ui/pages/LoginPage';
import LoaderPage from '../ui/pages/LoaderPage';
import AlignmentPage from '../ui/pages/AlignmentPage';
import RulesPage from '../ui/pages/RulesPage';
import VerificationPage from '../ui/pages/VerificationPage';
import EventsPage from '../ui/pages/EventsPage';
import EventDetailPage from '../ui/pages/EventDetailPage';
import EvidencePage from '../ui/pages/EvidencePage';
import DisposalPage from '../ui/pages/DisposalPage';
import SyncPage from '../ui/pages/SyncPage';
import SelfCheckPage from '../ui/pages/SelfCheckPage';
import CausalEditorPage from '../ui/causal/CausalEditorPage';
import CausalEvidencePage from '../ui/causal/CausalEvidencePage';
import ClaimCalculatorPage from '../ui/causal/ClaimCalculatorPage';
import MissingEvidencePage from '../ui/causal/MissingEvidencePage';
import RobustnessPage from '../ui/causal/RobustnessPage';

beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
});

function render(el: React.ReactElement) {
  return renderToString(
    <MemoryRouter>
      <AuthProvider>
        <AppProvider>
          <CausalProvider>{el}</CausalProvider>
        </AppProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('页面组件渲染冒烟', () => {
  const pages: Array<[string, React.ReactElement]> = [
    ['登录页', <LoginPage key="login" />],
    ['装载器页', <LoaderPage key="loader" />],
    ['对齐页', <AlignmentPage key="align" />],
    ['规则页', <RulesPage key="rules" />],
    ['核验页', <VerificationPage key="verify" />],
    ['事件列表页', <EventsPage key="events" />],
    ['事件调查页', <EventDetailPage key="detail" />],
    ['证据图页', <EvidencePage key="evidence" />],
    ['处置簿页', <DisposalPage key="disposal" />],
    ['同步对照页', <SyncPage key="sync" />],
    ['自检页', <SelfCheckPage key="selfcheck" />],
    ['因果图编辑器页', <CausalEditorPage key="cg-editor" />],
    ['证据语义标注册页', <CausalEvidencePage key="cg-evidence" />],
    ['主张计算器页', <ClaimCalculatorPage key="cg-claims" />],
    ['缺证传播器页', <MissingEvidencePage key="cg-missing" />],
    ['稳健性台页', <RobustnessPage key="cg-robust" />],
  ];

  for (const [name, el] of pages) {
    it(`${name}可渲染`, () => {
      const html = render(el);
      expect(html.length).toBeGreaterThan(0);
    });
  }

  it('登录页包含三个测试账号', () => {
    const html = render(<LoginPage />);
    expect(html).toContain('王监管');
    expect(html).toContain('张巡检');
    expect(html).toContain('陈审计');
  });
});
