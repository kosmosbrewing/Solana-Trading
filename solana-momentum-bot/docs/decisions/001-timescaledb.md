# ADR-001: TimescaleDB 선택

**상태:** 확정
**날짜:** 2026-02
**맥락:** OHLCV 캔들 데이터와 트레이드 이력의 시계열 저장소 필요

## 선택지

1. **TimescaleDB (PostgreSQL 확장)** — 시계열 전용, 압축, 보존 정책
2. **SQLite** — 단순, 임베디드
3. **InfluxDB** — 시계열 전용 DB

## 결정: TimescaleDB

## 이유

- PostgreSQL 호환: 기존 pg 드라이버 재사용, SQL 쿼리 그대로
- 시계열 압축: 캔들 데이터 장기 보관 시 스토리지 절약
- Continuous Aggregation: 다중 타임프레임 자동 집계
- 에이전트 학습 데이터 풍부 (PostgreSQL 기반)
- Vultr VPS 단일 서버에서 앱 + DB 공존 가능

## 트레이드오프

- SQLite 대비 운영 복잡도 증가
- VPS 메모리 추가 소비 (~200MB)
