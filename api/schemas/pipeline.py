from __future__ import annotations
from pydantic import BaseModel, Field, model_validator
from typing import Any

ALLOWED_PARAMS: set[str] = {
    "resolution", "n_circles",
    "road_resistance", "river_resistance", "landscape_resistance",
    "linear_resistance", "lamp_resistance",
    "road_weight", "river_weight", "landscape_weight",
    "linear_weight", "lamp_weight",
    "dtm_weight", "dsm_weight", "lcm_weight",
    "road_buffer", "river_buffer", "landscape_buffer",
    "linear_buffer", "lamp_buffer",
}


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

    @model_validator(mode="after")
    def _validate_params(self) -> "PipelineRequest":
        unknown = set(self.params) - ALLOWED_PARAMS
        if unknown:
            from fastapi import HTTPException
            raise HTTPException(
                status_code=400,
                detail=f"Unknown pipeline parameters: {', '.join(sorted(unknown))}",
            )
        return self


class PipelineStartResponse(BaseModel):
    job_id: str


class ResultLayerInfo(BaseModel):
    id: str
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
