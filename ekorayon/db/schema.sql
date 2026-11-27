CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff','school')),
  school_id BIGINT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS schools (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  locality TEXT,
  director TEXT,
  contact TEXT,
  students INTEGER NOT NULL DEFAULT 0 CHECK (students >= 0),
  description TEXT,
  photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_school_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_school_id_fkey FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS classes (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  students INTEGER NOT NULL DEFAULT 0 CHECK (students >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (school_id, name)
);
CREATE TABLE IF NOT EXISTS student_history (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id BIGINT REFERENCES classes(id) ON DELETE SET NULL,
  old_count INTEGER NOT NULL,
  new_count INTEGER NOT NULL,
  changed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS materials (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'кг'
);
INSERT INTO materials(code,name,unit) VALUES
 ('paper','Макулатура (бумага, картон)','кг'),('plastic','Пластик','кг'),('glass','Стекло','кг'),
 ('metal','Металл','кг'),('batteries','Батарейки','кг'),('electronics','Электронные отходы','кг')
ON CONFLICT (code) DO NOTHING;
CREATE TABLE IF NOT EXISTS collection_entries (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id BIGINT REFERENCES classes(id) ON DELETE SET NULL,
  material_code TEXT NOT NULL REFERENCES materials(code),
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  period_month DATE NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','correction')),
  review_comment TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS entry_history (
  id BIGSERIAL PRIMARY KEY,
  entry_id BIGINT NOT NULL REFERENCES collection_entries(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  details JSONB,
  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS class_requests (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('add','remove')),
  class_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS news (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'news',
  school_id BIGINT REFERENCES schools(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','pending','published','archived')),
  event_date DATE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  school_id BIGINT REFERENCES schools(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT REFERENCES schools(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  period_month DATE,
  file_type TEXT NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  admin_reply TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id BIGINT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_entries_period ON collection_entries(period_month);
CREATE INDEX IF NOT EXISTS idx_entries_school ON collection_entries(school_id);
CREATE INDEX IF NOT EXISTS idx_entries_status ON collection_entries(status);
CREATE INDEX IF NOT EXISTS idx_news_status ON news(status);


-- Система мотивационных баллов. Тарифы по умолчанию сохраняются при повторных запусках.
CREATE TABLE IF NOT EXISTS point_rates (
 material_code TEXT PRIMARY KEY REFERENCES materials(code) ON DELETE CASCADE,
 points_per_kg NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK(points_per_kg>=0),
 updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO point_rates(material_code,points_per_kg) VALUES
 ('paper',2),('plastic',5),('glass',1),('metal',3),('batteries',8),('electronics',10)
ON CONFLICT(material_code) DO NOTHING;
CREATE TABLE IF NOT EXISTS point_ledger (
 id BIGSERIAL PRIMARY KEY,
 school_id BIGINT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 entry_id BIGINT UNIQUE REFERENCES collection_entries(id) ON DELETE SET NULL,
 kind TEXT NOT NULL CHECK(kind IN ('collection','event','adjustment')),
 points NUMERIC(12,2) NOT NULL CHECK(points<>0),
 rate_snapshot NUMERIC(10,2),
 reason TEXT NOT NULL,
 created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_point_ledger_school ON point_ledger(school_id,created_at DESC);
