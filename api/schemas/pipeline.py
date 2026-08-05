from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Any


class RoostInput(BaseModel):
    lng: float
    lat: float
    radius_meters: float = Field(alias="radiusMeters")

    class Config:
        populate_by_name = True


class FeaturePayload(BaseModel):
    id: str
    category: str
    label: str
    geometry_kind: str = Field(alias="geometryKind")
    geojson: dict[str, Any]
    circle: dict[str, Any] | None = None
    data: dict[str, Any] | None = None

    class Config:
        populate_by_name = True


class PipelineRequest(BaseModel):
    roost: RoostInput
    features: list[FeaturePayload] = Field(default_factory=list)
    params: dict[str, int | float] = Field(default_factory=dict)


class PipelineStartResponse(BaseModel):
    job_id: str


class ResultLayerInfo(BaseModel):
    id: str
    name: str
    url: str
    bounds: tuple[float, float, float, float]


class JobStatus(BaseModel):
    job_id: str
    status: str  # pending | running | completed | failed | cancelled
    progress: float
    progress_label: str
    error: str | None = None
    warnings: list[str] = Field(default_factory=list)
    layers: list[ResultLayerInfo] | None = None


class JobLogsResponse(BaseModel):
    lines: list[str]
    offset: int
    has_more: bool
